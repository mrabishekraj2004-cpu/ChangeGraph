import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { parseChangeGraphEvent, type ChangeGraphEvent } from "./events";
import { redactSensitiveText } from "./agent-safety";

type PgRow = Record<string, unknown>;

export type PostgresQueuedEvent = {
  id: string;
  workspaceId: string;
  source: string;
  eventType: string;
  schemaVersion: number;
  externalId: string;
  idempotencyKey: string;
  payload: unknown;
  headers: Record<string, string | null>;
  status: string;
  attemptCount: number;
  nextAttemptAt: string | null;
  receivedAt: string;
  processedAt: string | null;
  lastError: string | null;
  processingStartedAt: string | null;
  processingWorkerId: string | null;
};

function validateSchema(value: string) {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(value)) throw new Error("Invalid PostgreSQL schema name.");
  return value;
}

function parseJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try { return JSON.parse(value) as unknown; } catch { return value; }
}

function asIso(value: unknown): string | null {
  if (value == null) return null;
  return value instanceof Date ? value.toISOString() : String(value);
}

function boundedInteger(value: number | undefined, fallback: number, min: number, max: number) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.min(max, Math.max(min, Math.floor(numeric))) : fallback;
}

const storedHeaderNames = new Set(["content-type", "user-agent", "x-github-delivery", "x-github-event", "traceparent", "tracestate", "x-request-id"]);

function safeHeaders(headers: Record<string, string | null>) {
  return Object.fromEntries(Object.entries(headers)
    .filter(([name, value]) => storedHeaderNames.has(name.toLowerCase()) && typeof value === "string")
    .map(([name, value]) => [name.toLowerCase(), redactSensitiveText(String(value)).replace(/[\r\n\t]+/g, " ").slice(0, 500)]));
}

function mapEvent(row: PgRow): PostgresQueuedEvent {
  return {
    id: String(row.id),
    workspaceId: String(row.workspace_id),
    source: String(row.source),
    eventType: String(row.event_type),
    schemaVersion: Number(row.schema_version),
    externalId: String(row.external_id),
    idempotencyKey: String(row.idempotency_key),
    payload: parseJson(row.payload_json),
    headers: (parseJson(row.headers_json) ?? {}) as Record<string, string | null>,
    status: String(row.status),
    attemptCount: Number(row.attempt_count),
    nextAttemptAt: asIso(row.next_attempt_at),
    receivedAt: asIso(row.received_at) ?? new Date(0).toISOString(),
    processedAt: asIso(row.processed_at),
    lastError: row.last_error == null ? null : String(row.last_error),
    processingStartedAt: asIso(row.processing_started_at),
    processingWorkerId: row.processing_worker_id == null ? null : String(row.processing_worker_id),
  };
}

async function transaction<T>(pool: Pool, work: (client: PoolClient) => Promise<T>) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export function createPostgresEventStore(pool: Pool, schemaName = "changegraph") {
  const schema = validateSchema(schemaName);

  return {
    async accept(event: ChangeGraphEvent, headers: Record<string, string | null> = {}) {
      const parsed = parseChangeGraphEvent(event);
      if (!parsed.success) throw new Error("Invalid ChangeGraph event.");
      const normalized = parsed.data;
      const filteredHeaders = safeHeaders(headers);
      const inserted = await pool.query<PgRow>(
        `INSERT INTO ${schema}.event_inbox
          (id, workspace_id, source, event_type, schema_version, external_id, idempotency_key, payload_json, headers_json, status, received_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, 'received', NOW())
         ON CONFLICT (workspace_id, source, idempotency_key) DO NOTHING
         RETURNING id, status`,
        [normalized.eventId, normalized.workspaceId, normalized.source, normalized.eventType, normalized.schemaVersion, normalized.externalId, normalized.idempotencyKey, JSON.stringify(normalized), JSON.stringify(filteredHeaders)],
      );
      if (inserted.rows[0]) return { accepted: true as const, duplicate: false as const, eventId: String(inserted.rows[0].id), status: String(inserted.rows[0].status) };

      const existing = await pool.query<PgRow>(
        `SELECT id, status FROM ${schema}.event_inbox WHERE workspace_id = $1 AND source = $2 AND idempotency_key = $3`,
        [normalized.workspaceId, normalized.source, normalized.idempotencyKey],
      );
      if (!existing.rows[0]) throw new Error("Idempotent event conflict could not be read back.");
      return { accepted: false as const, duplicate: true as const, eventId: String(existing.rows[0].id), status: String(existing.rows[0].status) };
    },

    async claimNext(workerId: string, options: { limit?: number; leaseSeconds?: number; workspaceId?: string } = {}) {
      const limit = boundedInteger(options.limit, 25, 1, 100);
      const leaseSeconds = boundedInteger(options.leaseSeconds, 300, 30, 3600);
      const staleBefore = new Date(Date.now() - leaseSeconds * 1000).toISOString();
      return transaction(pool, async (client) => {
        const params: Array<string | number> = [staleBefore];
        let workspaceClause = "";
        if (options.workspaceId) {
          params.push(options.workspaceId);
          workspaceClause = `AND workspace_id = $${params.length}`;
        }
        params.push(limit);
        const result = await client.query<PgRow>(
          `SELECT * FROM ${schema}.event_inbox
           WHERE (((status IN ('received', 'retrying')) AND (next_attempt_at IS NULL OR next_attempt_at <= NOW()))
             OR (status = 'processing' AND (processing_started_at IS NULL OR processing_started_at <= $1)))
             ${workspaceClause}
           ORDER BY received_at ASC
           LIMIT $${params.length}
           FOR UPDATE SKIP LOCKED`,
          params,
        );
        const claimed: Array<PostgresQueuedEvent & { attempt: number }> = [];
        for (const row of result.rows) {
          const attempt = Number(row.attempt_count) + 1;
          const startedAt = new Date();
          const updated = await client.query<PgRow>(
            `UPDATE ${schema}.event_inbox
             SET status = 'processing', attempt_count = $1, last_error = NULL, processing_started_at = $2, processing_worker_id = $3
             WHERE id = $4 AND workspace_id = $5
             RETURNING *`,
            [attempt, startedAt, workerId, String(row.id), String(row.workspace_id)],
          );
          const attemptId = `attempt_${randomUUID().replaceAll("-", "").slice(0, 18)}`;
          await client.query(
            `INSERT INTO ${schema}.event_attempts (id, event_id, attempt, status, started_at) VALUES ($1, $2, $3, 'processing', $4)`,
            [attemptId, String(row.id), attempt, startedAt],
          );
          claimed.push({ ...mapEvent(updated.rows[0]), attempt });
        }
        return claimed;
      });
    },

    async markProcessed(workspaceId: string, eventId: string, workerId: string) {
      return transaction(pool, async (client) => {
        const event = await client.query<PgRow>(
          `SELECT attempt_count FROM ${schema}.event_inbox
           WHERE workspace_id = $1 AND id = $2 AND status = 'processing' AND processing_worker_id = $3
           FOR UPDATE`,
          [workspaceId, eventId, workerId],
        );
        if (!event.rows[0]) throw new Error("Event lease was lost before completion.");
        const finishedAt = new Date();
        const attempt = await client.query(
          `UPDATE ${schema}.event_attempts SET status = 'succeeded', finished_at = $1
           WHERE event_id = $2 AND attempt = $3 AND status = 'processing'`,
          [finishedAt, eventId, Number(event.rows[0].attempt_count)],
        );
        if ((attempt.rowCount ?? 0) !== 1) throw new Error("Active event attempt was not found.");
        await client.query(
          `UPDATE ${schema}.event_inbox
           SET status = 'processed', processed_at = $1, next_attempt_at = NULL, processing_started_at = NULL, processing_worker_id = NULL
           WHERE workspace_id = $2 AND id = $3`,
          [finishedAt, workspaceId, eventId],
        );
        return { eventId, status: "processed" as const, attempt: Number(event.rows[0].attempt_count) };
      });
    },

    async markFailed(workspaceId: string, eventId: string, workerId: string, reason: string, policy: { maxAttempts?: number; baseDelayMs?: number; maxDelayMs?: number } = {}) {
      const maxAttempts = boundedInteger(policy.maxAttempts, 3, 1, 10);
      const baseDelayMs = boundedInteger(policy.baseDelayMs, 1_000, 1, 60_000);
      const maxDelayMs = boundedInteger(policy.maxDelayMs, 300_000, baseDelayMs, 3_600_000);
      const safeReason = redactSensitiveText(reason).replace(/[\r\n\t]+/g, " ").slice(0, 1_000) || "Event processing failed.";
      return transaction(pool, async (client) => {
        const event = await client.query<PgRow>(
          `SELECT * FROM ${schema}.event_inbox
           WHERE workspace_id = $1 AND id = $2 AND status = 'processing' AND processing_worker_id = $3
           FOR UPDATE`,
          [workspaceId, eventId, workerId],
        );
        const row = event.rows[0];
        if (!row) throw new Error("Event lease was lost before failure handling.");
        const attemptCount = Number(row.attempt_count);
        const failedAt = new Date();
        const attempt = await client.query(
          `UPDATE ${schema}.event_attempts SET status = 'failed', error = $1, finished_at = $2
           WHERE event_id = $3 AND attempt = $4 AND status = 'processing'`,
          [safeReason, failedAt, eventId, attemptCount],
        );
        if ((attempt.rowCount ?? 0) !== 1) throw new Error("Active event attempt was not found.");

        if (attemptCount >= maxAttempts) {
          await client.query(
            `INSERT INTO ${schema}.dead_letter_events (id, workspace_id, event_id, reason, payload_json, attempts, failed_at)
             VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7)
             ON CONFLICT (event_id) DO UPDATE SET reason = EXCLUDED.reason, payload_json = EXCLUDED.payload_json, attempts = EXCLUDED.attempts, failed_at = EXCLUDED.failed_at`,
            [`dlq_${randomUUID().replaceAll("-", "").slice(0, 18)}`, workspaceId, eventId, safeReason, JSON.stringify(parseJson(row.payload_json)), attemptCount, failedAt],
          );
          await client.query(
            `UPDATE ${schema}.event_inbox SET status = 'dead_letter', last_error = $1, next_attempt_at = NULL, processing_started_at = NULL, processing_worker_id = NULL WHERE workspace_id = $2 AND id = $3`,
            [safeReason, workspaceId, eventId],
          );
          return { eventId, status: "dead_letter" as const, attempt: attemptCount };
        }

        const retryDelay = Math.min(maxDelayMs, baseDelayMs * 2 ** Math.min(20, attemptCount - 1));
        const retryAt = new Date(failedAt.getTime() + retryDelay);
        await client.query(
          `UPDATE ${schema}.event_inbox SET status = 'retrying', last_error = $1, next_attempt_at = $2, processing_started_at = NULL, processing_worker_id = NULL WHERE workspace_id = $3 AND id = $4`,
          [safeReason, retryAt, workspaceId, eventId],
        );
        return { eventId, status: "retrying" as const, attempt: attemptCount, retryAt: retryAt.toISOString() };
      });
    },

    async replayDeadLetter(workspaceId: string, deadLetterId: string) {
      return transaction(pool, async (client) => {
        const deadLetter = await client.query<PgRow>(
          `SELECT dlq.event_id FROM ${schema}.dead_letter_events dlq
           JOIN ${schema}.event_inbox inbox ON inbox.workspace_id = dlq.workspace_id AND inbox.id = dlq.event_id
           WHERE dlq.workspace_id = $1 AND dlq.id = $2 AND inbox.status = 'dead_letter'
           FOR UPDATE OF inbox`,
          [workspaceId, deadLetterId],
        );
        const row = deadLetter.rows[0];
        if (!row) return null;
        const eventId = String(row.event_id);
        await client.query(
          `UPDATE ${schema}.event_inbox SET status = 'received', attempt_count = 0, next_attempt_at = NULL, processed_at = NULL, last_error = NULL, processing_started_at = NULL, processing_worker_id = NULL WHERE workspace_id = $1 AND id = $2`,
          [workspaceId, eventId],
        );
        await client.query(`DELETE FROM ${schema}.dead_letter_events WHERE workspace_id = $1 AND id = $2`, [workspaceId, deadLetterId]);
        return { eventId };
      });
    },

    async getStatus(workspaceId: string, eventId: string) {
      const result = await pool.query<PgRow>(
        `SELECT id, workspace_id, status, attempt_count, received_at, processed_at, next_attempt_at, last_error
         FROM ${schema}.event_inbox WHERE workspace_id = $1 AND id = $2`,
        [workspaceId, eventId],
      );
      const row = result.rows[0];
      if (!row) return undefined;
      return { id: String(row.id), workspaceId: String(row.workspace_id), status: String(row.status), attemptCount: Number(row.attempt_count), receivedAt: asIso(row.received_at), processedAt: asIso(row.processed_at), nextAttemptAt: asIso(row.next_attempt_at), lastError: row.last_error == null ? null : String(row.last_error) };
    },
  };
}
