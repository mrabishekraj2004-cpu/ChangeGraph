import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { eventTimestamp, parseChangeGraphEvent, type ChangeGraphEvent } from "./events";
import { createPostgresEventStore, type PostgresQueuedEvent } from "./postgres-event-store";

type Row = Record<string, unknown>;
type ClaimedEvent = PostgresQueuedEvent & { attempt: number };
type FailurePolicy = { maxAttempts?: number; baseDelayMs?: number; maxDelayMs?: number };

function validateSchema(value: string) {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(value)) throw new Error("Invalid PostgreSQL schema name.");
  return value;
}

function id(prefix: string) {
  return `${prefix}_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
}

function slug(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 80) || "unknown-service";
}

function timestamp(value: string) {
  return eventTimestamp(value);
}

export function createPostgresEventHandlers(pool: Pool, schemaName = "changegraph") {
  const schema = validateSchema(schemaName);
  const queue = createPostgresEventStore(pool, schema);

  async function audit(client: PoolClient, event: ChangeGraphEvent, action: string, entityType: string, entityId: string, extra: Row = {}) {
    await client.query(
      `INSERT INTO ${schema}.audit_events (id, workspace_id, actor_user_id, action, entity_type, entity_id, metadata_json, created_at)
       VALUES ($1, $2, NULL, $3, $4, $5, $6::jsonb, NOW()) ON CONFLICT (id) DO NOTHING`,
      [`audit_${event.eventId}`, event.workspaceId, action, entityType, entityId,
        JSON.stringify({ externalId: event.externalId, source: event.source, ...extra })],
    );
  }

  async function ensureService(client: PoolClient, workspaceId: string, rawSlug: string, name: string, owner = "Unknown", status = "unknown", healthScore = 0) {
    const normalized = slug(rawSlug);
    const result = await client.query<{ id: string }>(
      `INSERT INTO ${schema}.services (id, workspace_id, name, slug, owner, status, health_score)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (workspace_id, slug) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
      [id("svc"), workspaceId, name, normalized, owner, status, healthScore],
    );
    return result.rows[0].id;
  }

  async function ensureChange(client: PoolClient, workspaceId: string, input: {
    sha: string; title: string; author: string; repository: string; url?: string; riskLabel?: string; createdAt?: string;
  }, provider: string, externalId: string) {
    const existing = await client.query<{ id: string }>(
      `SELECT id FROM ${schema}.changes WHERE workspace_id = $1
       AND (sha = $2 OR (provider = $3 AND external_id = $4))
       ORDER BY (sha = $2) DESC LIMIT 1 FOR UPDATE`,
      [workspaceId, input.sha, provider, externalId],
    );
    const values = [workspaceId, input.sha, input.title, input.author, input.repository,
      input.url ?? null, input.riskLabel ?? "unknown", timestamp(input.createdAt ?? new Date().toISOString()), provider, externalId];
    if (existing.rows[0]) {
      await client.query(
        `UPDATE ${schema}.changes SET sha = $2, title = $3, author = $4, repository = $5,
         url = $6, risk_label = $7, created_at = $8, provider = $9, external_id = $10
         WHERE workspace_id = $1 AND id = $11`, [...values, existing.rows[0].id],
      );
      return existing.rows[0].id;
    }
    const changeId = id("chg");
    await client.query(
      `INSERT INTO ${schema}.changes
       (id, workspace_id, sha, title, author, repository, url, risk_label, created_at, provider, external_id)
       VALUES ($11, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`, [...values, changeId],
    );
    return changeId;
  }

  async function handle(client: PoolClient, event: ChangeGraphEvent) {
    const workspaceId = event.workspaceId;
    if (event.eventType === "service.metadata.v1") {
      const payload = event.payload;
      const serviceId = await ensureService(client, workspaceId, payload.slug, payload.name, payload.owner,
        payload.status || "unknown", payload.healthScore ?? 0);
      await client.query(
        `UPDATE ${schema}.services SET owner = $3, status = $4, health_score = $5
         WHERE workspace_id = $1 AND id = $2`,
        [workspaceId, serviceId, payload.owner, payload.status || "unknown", payload.healthScore ?? 0],
      );
      if (payload.dependencies) {
        await client.query(`DELETE FROM ${schema}.service_dependencies WHERE workspace_id = $1 AND downstream_service_id = $2`, [workspaceId, serviceId]);
        for (const dependency of payload.dependencies) {
          const upstreamId = await ensureService(client, workspaceId, dependency, dependency);
          if (upstreamId === serviceId) continue;
          await client.query(
            `INSERT INTO ${schema}.service_dependencies
             (workspace_id, upstream_service_id, downstream_service_id, dependency_kind, created_at)
             VALUES ($1, $2, $3, 'runtime', NOW()) ON CONFLICT DO NOTHING`,
            [workspaceId, upstreamId, serviceId],
          );
        }
      }
      await audit(client, event, "event.service_metadata.upserted", "service", serviceId);
      return;
    }

    if (event.eventType === "source.change.v1") {
      const changeId = await ensureChange(client, workspaceId, event.payload, event.source, event.externalId);
      await audit(client, event, "event.change.upserted", "change", changeId);
      return;
    }

    if (event.eventType === "deployment.v1") {
      const payload = event.payload;
      const serviceId = await ensureService(client, workspaceId, payload.serviceSlug, payload.serviceName || payload.serviceSlug);
      const changeId = await ensureChange(client, workspaceId, {
        sha: payload.changeSha || `deployment:${event.externalId}`,
        title: payload.changeTitle || `Deployment ${payload.version}`,
        author: payload.author || "Unknown",
        repository: payload.repository || "unknown/repository",
        url: payload.url,
        createdAt: payload.startedAt,
      }, event.source, payload.changeSha || event.externalId);
      const existing = await client.query<{ id: string }>(
        `SELECT id FROM ${schema}.deployments WHERE workspace_id = $1 AND provider = $2 AND external_id = $3 FOR UPDATE`,
        [workspaceId, event.source, event.externalId],
      );
      const deploymentId = existing.rows[0]?.id ?? id("dep");
      const values = [workspaceId, serviceId, changeId, payload.version, payload.environment, payload.status,
        timestamp(payload.startedAt), payload.completedAt ? timestamp(payload.completedAt) : null, payload.url ?? null];
      if (existing.rows[0]) {
        await client.query(
          `UPDATE ${schema}.deployments SET service_id = $2, change_id = $3, version = $4,
           environment = $5, status = $6, started_at = $7, completed_at = $8, url = $9
           WHERE workspace_id = $1 AND id = $10`, [...values, deploymentId],
        );
      } else {
        await client.query(
          `INSERT INTO ${schema}.deployments
           (id, workspace_id, service_id, change_id, version, environment, status, started_at,
            completed_at, url, provider, external_id)
           VALUES ($10, $1, $2, $3, $4, $5, $6, $7, $8, $9, $11, $12)`,
          [...values, deploymentId, event.source, event.externalId],
        );
      }
      await client.query(
        `UPDATE ${schema}.services SET last_deploy_at = $3 WHERE workspace_id = $1 AND id = $2
         AND (last_deploy_at IS NULL OR last_deploy_at <= $3)`,
        [workspaceId, serviceId, timestamp(payload.startedAt)],
      );
      const incidents = await client.query<{ id: string }>(
        `SELECT id FROM ${schema}.incidents WHERE workspace_id = $1 AND service_id = $2
         AND status NOT IN ('resolved', 'closed')`, [workspaceId, serviceId],
      );
      for (const incident of incidents.rows) {
        await client.query(
          `INSERT INTO ${schema}.timeline_events
           (id, workspace_id, incident_id, occurred_at, type, title, description, source_url, evidence_kind, evidence_ref)
           VALUES ($1, $2, $3, $4, 'change', $5, $6, $7, 'deployment', $8)
           ON CONFLICT (id) DO NOTHING`,
          [`evt_${event.eventId}_${incident.id}`, workspaceId, incident.id, timestamp(payload.startedAt),
            `Deployment ${payload.version} ${payload.status}`, `${payload.serviceSlug} deployment reported ${payload.status}.`,
            payload.url ?? null, deploymentId],
        );
      }
      await audit(client, event, "event.deployment.upserted", "deployment", deploymentId);
      return;
    }

    const payload = event.payload;
    const service = await client.query<{ id: string }>(
      `SELECT id FROM ${schema}.services WHERE workspace_id = $1 AND (name = $2 OR slug = $3) LIMIT 1`,
      [workspaceId, payload.serviceName, slug(payload.serviceName)],
    );
    const incident = payload.incidentId ? await client.query<{ id: string }>(
      `SELECT id FROM ${schema}.incidents WHERE workspace_id = $1 AND id = $2`,
      [workspaceId, payload.incidentId],
    ) : null;
    if (payload.incidentId && !incident?.rows[0]) throw new Error("Telemetry incident does not belong to the event workspace.");
    const referenceId = id("tel");
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO ${schema}.telemetry_references
       (id, workspace_id, incident_id, service_id, signal_kind, external_ref, observed_at,
        summary, source_url, payload_json, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, NOW())
       ON CONFLICT (workspace_id, signal_kind, external_ref) DO NOTHING RETURNING id`,
      [referenceId, workspaceId, incident?.rows[0]?.id ?? null, service.rows[0]?.id ?? null,
        payload.signalKind, payload.externalRef, timestamp(payload.observedAt), payload.summary,
        payload.sourceUrl ?? null, JSON.stringify(payload.payload ?? {})],
    );
    if (inserted.rows[0]) {
      await client.query(
        `INSERT INTO ${schema}.signals
         (id, workspace_id, incident_id, kind, service_name, observed_at, payload_json, source)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8) ON CONFLICT (id) DO NOTHING`,
        [`sig_${event.eventId}`, workspaceId, incident?.rows[0]?.id ?? null, payload.signalKind,
          payload.serviceName, timestamp(payload.observedAt), JSON.stringify(payload.payload ?? {}), event.source],
      );
      if (incident?.rows[0]) {
        await client.query(
          `INSERT INTO ${schema}.timeline_events
           (id, workspace_id, incident_id, occurred_at, type, title, description, source_url, evidence_kind, evidence_ref)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) ON CONFLICT (id) DO NOTHING`,
          [`evt_${event.eventId}_${incident.rows[0].id}`, workspaceId, incident.rows[0].id,
            timestamp(payload.observedAt), payload.signalKind, `${payload.signalKind} reference received`,
            payload.summary, payload.sourceUrl ?? null, payload.signalKind, payload.externalRef],
        );
      }
    }
    await audit(client, event, "event.telemetry_reference.recorded", "telemetry_reference",
      inserted.rows[0]?.id ?? referenceId, { inserted: Boolean(inserted.rows[0]) });
  }

  async function processClaimed(claim: ClaimedEvent, workerId: string, policy: FailurePolicy = {}) {
    const client = await pool.connect();
    let released = false;
    try {
      await client.query("BEGIN");
      const lease = await client.query<Row>(
        `SELECT payload_json, workspace_id, source, event_type, schema_version, external_id,
                idempotency_key, attempt_count FROM ${schema}.event_inbox
         WHERE workspace_id = $1 AND id = $2 AND status = 'processing' AND processing_worker_id = $3
         FOR UPDATE`, [claim.workspaceId, claim.id, workerId],
      );
      const row = lease.rows[0];
      if (!row || Number(row.attempt_count) !== claim.attempt) throw new Error("Event lease was lost before processing.");
      const parsed = parseChangeGraphEvent(row.payload_json);
      if (!parsed.success) throw new Error(`Invalid ChangeGraph event: ${parsed.error.issues.map((issue) => issue.path.join(".") || "event").join(", ")}`);
      const event = parsed.data;
      if (event.workspaceId !== claim.workspaceId || event.eventId !== claim.id ||
          event.source !== row.source || event.eventType !== row.event_type ||
          event.schemaVersion !== Number(row.schema_version) || event.externalId !== row.external_id ||
          event.idempotencyKey !== row.idempotency_key) throw new Error("Queued event metadata does not match its payload.");
      // Serialize workspace writes to avoid duplicate domain rows without provider-specific unique indexes.
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [claim.workspaceId]);
      const workspace = await client.query(`SELECT id FROM ${schema}.workspaces WHERE id = $1`, [claim.workspaceId]);
      if (!workspace.rows[0]) throw new Error("Event workspace does not exist.");
      await handle(client, event);
      const finishedAt = new Date();
      const attempt = await client.query(
        `UPDATE ${schema}.event_attempts SET status = 'succeeded', finished_at = $1
         WHERE event_id = $2 AND attempt = $3 AND status = 'processing'`,
        [finishedAt, claim.id, claim.attempt],
      );
      if (attempt.rowCount !== 1) throw new Error("Active event attempt was not found.");
      await client.query(
        `UPDATE ${schema}.event_inbox SET status = 'processed', processed_at = $1,
         next_attempt_at = NULL, processing_started_at = NULL, processing_worker_id = NULL
         WHERE workspace_id = $2 AND id = $3`, [finishedAt, claim.workspaceId, claim.id],
      );
      await client.query("COMMIT");
      return { eventId: claim.id, status: "processed" as const, attempt: claim.attempt };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      client.release();
      released = true;
      if (error instanceof Error && error.message.startsWith("Event lease was lost")) throw error;
      const reason = error instanceof Error ? error.message : "Unknown event processing failure";
      return queue.markFailed(claim.workspaceId, claim.id, workerId, reason, policy);
    } finally {
      if (!released) client.release();
    }
  }

  return {
    processClaimed,
    async processPending(workerId: string, options: { limit?: number; leaseSeconds?: number; workspaceId?: string; failurePolicy?: FailurePolicy } = {}) {
      const claims = await queue.claimNext(workerId, options);
      const results = [];
      for (const claim of claims) results.push(await processClaimed(claim, workerId, options.failurePolicy));
      return results;
    },
  };
}
