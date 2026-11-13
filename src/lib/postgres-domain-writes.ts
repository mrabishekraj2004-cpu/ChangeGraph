import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type { createIncident as sqliteCreateIncident, saveSignal as sqliteSaveSignal } from "./db";
import type { EvaluationReplay } from "./evaluations";

type IncidentInput = Parameters<typeof sqliteCreateIncident>[1];
type SignalInput = Parameters<typeof sqliteSaveSignal>[0];

function validSchema(value: string) {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(value)) throw new Error("Invalid PostgreSQL schema name.");
  return value;
}

async function transaction<T>(pool: Pool, work: (client: PoolClient) => Promise<T>): Promise<T> {
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

/** Async PostgreSQL counterparts to the domain writes in db.ts. */
export function createPostgresDomainWrites(pool: Pool, schemaName = "changegraph") {
  const schema = validSchema(schemaName);

  return {
    async createIncident(workspaceId: string, input: IncidentInput): Promise<{ id: string; key: string }> {
      // The human-facing key has a small range; retry only a key collision in this workspace.
      for (let attempt = 0; attempt < 20; attempt++) {
        const id = `inc_${randomUUID().replaceAll("-", "").slice(0, 18)}`;
        const key = `INC-${Math.floor(1000 + Math.random() * 9000)}`;
        const inserted = await pool.query(
            `INSERT INTO ${schema}.incidents
               (id, workspace_id, key, title, service_id, severity, status, started_at, detected_at, summary, impact)
             VALUES ($1, $2, $3, $4, $5, $6, 'investigating', NOW(), NOW(), $7, $8)
             ON CONFLICT (workspace_id, key) DO NOTHING RETURNING id`,
            [id, workspaceId, key, input.title, input.serviceId, input.severity, input.summary, input.impact],
          );
        if (inserted.rowCount === 1) return { id, key };
      }
      throw new Error("Unable to allocate a unique incident key.");
    },

    async saveSignal(input: SignalInput): Promise<string> {
      const id = `sig_${randomUUID().replaceAll("-", "").slice(0, 18)}`;
      await pool.query(
        `INSERT INTO ${schema}.signals
           (id, workspace_id, incident_id, kind, service_name, observed_at, payload_json, source)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)`,
        [id, input.workspaceId, input.incidentId ?? null, input.kind, input.serviceName,
          input.observedAt, JSON.stringify(input.payload) ?? "null", input.source],
      );
      return id;
    },

    /** Persist a completed replay and its case results as one workspace-scoped unit. */
    async saveEvaluationReplay(workspaceId: string, evaluationId: string, replay: EvaluationReplay): Promise<string> {
      return transaction(pool, async (client) => {
        const evaluation = await client.query(
          `SELECT id FROM ${schema}.evaluations WHERE workspace_id = $1 AND id = $2 FOR UPDATE`,
          [workspaceId, evaluationId],
        );
        if (evaluation.rowCount !== 1) throw new Error("Evaluation not found in workspace.");

        const cases = await client.query<{ id: string }>(
          `SELECT id FROM ${schema}.evaluation_cases WHERE workspace_id = $1 AND evaluation_id = $2 FOR UPDATE`,
          [workspaceId, evaluationId],
        );
        const expectedIds = new Set(cases.rows.map((row) => row.id));
        const submittedIds = new Set(replay.cases.map((item) => item.id));
        if (submittedIds.size !== expectedIds.size || replay.cases.length !== expectedIds.size ||
            [...submittedIds].some((id) => !expectedIds.has(id))) {
          throw new Error("Replay cases do not match the evaluation.");
        }

        await client.query(
          `INSERT INTO ${schema}.evaluation_runs
             (id, workspace_id, evaluation_id, status, total_cases, top3_accuracy, evidence_coverage,
              detection_lag_ms, abstention_accuracy, details_json, started_at, completed_at)
           VALUES ($1, $2, $3, 'succeeded', $4, $5, $6, $7, $8, $9::jsonb, $10, $11)`,
          [replay.runId, workspaceId, evaluationId, replay.cases.length, replay.metrics.top3Accuracy,
            replay.metrics.evidenceCoverage, replay.metrics.detectionLagMs, replay.metrics.appropriateAbstention,
            JSON.stringify({ metrics: replay.metrics, cases: replay.cases }), replay.startedAt, replay.completedAt],
        );

        for (const item of replay.cases) {
          await client.query(
            `INSERT INTO ${schema}.evaluation_case_results
               (id, workspace_id, evaluation_run_id, evaluation_case_id, top3_hit, evidence_coverage,
                detection_lag_ms, abstention_expected, abstention_correct, predicted_json, evidence_refs_json, created_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11::jsonb, $12)`,
            [`evalcase_${randomUUID().replaceAll("-", "").slice(0, 18)}`, workspaceId, replay.runId,
              item.id, item.top3Hit, item.evidenceCoverage, item.detectionLagMs, item.expectedAbstention,
              item.abstentionCorrect, JSON.stringify(item.predicted), JSON.stringify(item.evidenceRefs), replay.completedAt],
          );
          await client.query(
            `UPDATE ${schema}.evaluation_cases SET status = $1, confidence = $2
             WHERE workspace_id = $3 AND evaluation_id = $4 AND id = $5`,
            [item.status, item.confidence, workspaceId, evaluationId, item.id],
          );
        }
        await client.query(
          `UPDATE ${schema}.evaluations SET pass_rate = $1, last_run_at = $2 WHERE workspace_id = $3 AND id = $4`,
          [replay.passRate, replay.completedAt, workspaceId, evaluationId],
        );
        return replay.runId;
      });
    },
  };
}
