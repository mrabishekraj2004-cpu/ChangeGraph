import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createPostgresEventStore } from "../src/lib/postgres-event-store";
import type { ChangeGraphEvent } from "../src/lib/events";
import { createPostgresIdentityStore, createPostgresPool, postgresIdentitySchema, runPostgresMigrations } from "../src/lib/postgres-identity-store";

const connectionString = process.env.DATABASE_URL?.trim();
if (!connectionString) throw new Error("DATABASE_URL is required for the PostgreSQL identity check.");

async function main(databaseUrl: string) {
  const pool = createPostgresPool(databaseUrl);
  const testSchema = `${postgresIdentitySchema}_test_${randomUUID().replaceAll("-", "").slice(0, 16)}`;

  try {
  await runPostgresMigrations(pool, testSchema);
  await runPostgresMigrations(pool, testSchema);
  const store = createPostgresIdentityStore(pool, testSchema);

  const owner = await store.createUser({ name: "PostgreSQL Owner", email: "postgres-owner@example.com", password: "owner-password-123" });
  const ownerWorkspace = await store.getWorkspaceForUser(owner.id, owner.workspaceId);
  assert.equal(ownerWorkspace?.role, "owner");

  const verification = await store.consumeEmailToken(owner.verificationToken, "verify");
  assert.ok(verification);
  await store.markUserVerified(owner.id);
  await store.markTokenUsed(verification!.id);
  assert.equal(await store.consumeEmailToken(owner.verificationToken, "verify"), undefined);

  const session = await store.createSession(owner.id, owner.workspaceId);
  assert.equal((await store.findSession(session.id))?.workspace_id, owner.workspaceId);

  const member = await store.createUser({ name: "PostgreSQL Member", email: "postgres-member@example.com", password: "member-password-123" });
  const added = await store.addWorkspaceMember(owner.workspaceId, "postgres-member@example.com", "member");
  assert.deepEqual(added, { ok: true, userId: member.id });
  assert.equal(await store.addWorkspaceMember(owner.workspaceId, "postgres-member@example.com", "member").then((result) => result.ok), false);
  assert.equal((await store.getWorkspaceForUser(member.id, owner.workspaceId))?.role, "member");
  assert.equal(await store.getWorkspaceForUser(owner.id, member.workspaceId), undefined);
  assert.equal(await store.updateWorkspaceMemberRole(owner.workspaceId, member.id, "responder"), true);
  assert.equal(await store.updateWorkspaceMemberRole(owner.workspaceId, owner.id, "member"), false);
  assert.equal(await store.removeWorkspaceMember(owner.workspaceId, owner.id), false);
  await assert.rejects(store.createSession(owner.id, member.workspaceId), (error: { code?: string }) => error.code === "23503");

  const timestamp = new Date().toISOString();
  const insertService = (id: string, workspaceId: string, name: string) => pool.query(
    `INSERT INTO ${testSchema}.services (id, workspace_id, name, slug, owner, status, health_score) VALUES ($1, $2, $3, $4, 'platform', 'healthy', 100)`,
    [id, workspaceId, name, name.toLowerCase().replaceAll(" ", "-")],
  );
  await insertService("svc_owner_checkout", owner.workspaceId, "Checkout");
  await insertService("svc_owner_catalog", owner.workspaceId, "Catalog");
  await insertService("svc_member_foreign", member.workspaceId, "Foreign");
  await pool.query(
    `INSERT INTO ${testSchema}.service_dependencies (workspace_id, upstream_service_id, downstream_service_id, created_at) VALUES ($1, $2, $3, $4)`,
    [owner.workspaceId, "svc_owner_catalog", "svc_owner_checkout", timestamp],
  );
  await assert.rejects(
    pool.query(
      `INSERT INTO ${testSchema}.service_dependencies (workspace_id, upstream_service_id, downstream_service_id, created_at) VALUES ($1, $2, $3, $4)`,
      [owner.workspaceId, "svc_member_foreign", "svc_owner_checkout", timestamp],
    ),
    (error: { code?: string }) => error.code === "23503",
  );
  await pool.query(
    `INSERT INTO ${testSchema}.changes (id, workspace_id, sha, title, author, repository, risk_label, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    ["chg_owner", owner.workspaceId, "0123456789abcdef", "Add cart guard", "Owner", "sample/repo", "low", timestamp],
  );
  await assert.rejects(
    pool.query(
      `INSERT INTO ${testSchema}.deployments (id, workspace_id, service_id, change_id, version, environment, status, started_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      ["dep_cross_workspace", owner.workspaceId, "svc_member_foreign", "chg_owner", "v1", "prod", "succeeded", timestamp],
    ),
    (error: { code?: string }) => error.code === "23503",
  );
  await pool.query(
    `INSERT INTO ${testSchema}.deployments (id, workspace_id, service_id, change_id, version, environment, status, started_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    ["dep_owner", owner.workspaceId, "svc_owner_checkout", "chg_owner", "v1", "prod", "succeeded", timestamp],
  );
  await pool.query(
    `INSERT INTO ${testSchema}.incidents (id, workspace_id, key, title, service_id, severity, status, started_at, detected_at, summary, impact) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8, $9, $10)`,
    ["inc_owner", owner.workspaceId, "INC-PG-1", "Checkout latency", "svc_owner_checkout", "high", "investigating", timestamp, "Latency increased after deployment", "Checkout requests are slow"],
  );
  await pool.query(
    `INSERT INTO ${testSchema}.telemetry_references (id, workspace_id, incident_id, service_id, signal_kind, external_ref, observed_at, summary, payload_json, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, '{}'::jsonb, $7)`,
    ["tel_owner", owner.workspaceId, "inc_owner", "svc_owner_checkout", "trace", "trace:pg-check", timestamp, "Slow checkout trace"],
  );
  await pool.query(`DELETE FROM ${testSchema}.incidents WHERE workspace_id = $1 AND id = $2`, [owner.workspaceId, "inc_owner"]);
  const telemetryAfterIncidentDelete = await pool.query<{ workspace_id: string; incident_id: string | null }>(
    `SELECT workspace_id, incident_id FROM ${testSchema}.telemetry_references WHERE id = $1`, ["tel_owner"],
  );
  assert.deepEqual(telemetryAfterIncidentDelete.rows[0], { workspace_id: owner.workspaceId, incident_id: null });
  await pool.query(
    `INSERT INTO ${testSchema}.runbooks (id, workspace_id, service_id, slug, title, summary, content, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8)`,
    ["rb_owner", owner.workspaceId, "svc_owner_catalog", "catalog-check", "Catalog checks", "Check catalog health", "Inspect the upstream catalog dependency", timestamp],
  );
  await pool.query(`DELETE FROM ${testSchema}.services WHERE workspace_id = $1 AND id = $2`, [owner.workspaceId, "svc_owner_catalog"]);
  const runbookAfterServiceDelete = await pool.query<{ workspace_id: string; service_id: string | null }>(
    `SELECT workspace_id, service_id FROM ${testSchema}.runbooks WHERE id = $1`, ["rb_owner"],
  );
  assert.deepEqual(runbookAfterServiceDelete.rows[0], { workspace_id: owner.workspaceId, service_id: null });

  const secondWorkspace = await store.createWorkspace(owner.id, { name: "Database Migration Review", mode: "production" });
  assert.equal(await store.switchSessionWorkspace(session.id, owner.id, secondWorkspace.id), true);
  assert.equal((await store.findSession(session.id))?.workspace_id, secondWorkspace.id);

  const eventStore = createPostgresEventStore(pool, testSchema);
  const makeEvent = (eventId: string, workspaceId: string, idempotencyKey: string): ChangeGraphEvent => ({
    schemaVersion: 1,
    eventId,
    eventType: "service.metadata.v1",
    source: "postgres-test",
    externalId: eventId,
    idempotencyKey,
    workspaceId,
    occurredAt: new Date().toISOString(),
    payload: { slug: "queue-test", name: "Queue Test", owner: "Platform" },
  });
  const eventA = makeEvent("evt_pg_a", owner.workspaceId, "shared-delivery-key");
  const acceptedA = await eventStore.accept(eventA, { "Content-Type": "application/json", "X-GitHub-Event": "push", Authorization: "Bearer fake-test-token-1234567890" });
  assert.deepEqual(acceptedA, { accepted: true, duplicate: false, eventId: eventA.eventId, status: "received" });
  const duplicateA = await eventStore.accept(makeEvent("evt_pg_a_duplicate", owner.workspaceId, "shared-delivery-key"));
  assert.deepEqual(duplicateA, { accepted: false, duplicate: true, eventId: eventA.eventId, status: "received" });
  const sameDeliveryOtherWorkspace = await eventStore.accept(makeEvent("evt_pg_other_workspace", member.workspaceId, "shared-delivery-key"));
  assert.equal(sameDeliveryOtherWorkspace.accepted, true);
  const [eventAClaim] = await eventStore.claimNext("worker-initial", { limit: 1, workspaceId: owner.workspaceId });
  assert.equal(eventAClaim.id, eventA.eventId);
  assert.deepEqual(eventAClaim.headers, { "content-type": "application/json", "x-github-event": "push" });
  await eventStore.markProcessed(eventAClaim.workspaceId, eventAClaim.id, "worker-initial");
  const concurrentA = makeEvent("evt_pg_concurrent_a", owner.workspaceId, "concurrent-a");
  const concurrentB = makeEvent("evt_pg_concurrent_b", owner.workspaceId, "concurrent-b");
  await eventStore.accept(concurrentA);
  await eventStore.accept(concurrentB);
  const [workerAClaims, workerBClaims] = await Promise.all([
    eventStore.claimNext("worker-a", { limit: 1, workspaceId: owner.workspaceId }),
    eventStore.claimNext("worker-b", { limit: 1, workspaceId: owner.workspaceId }),
  ]);
  assert.equal(workerAClaims.length, 1);
  assert.equal(workerBClaims.length, 1);
  assert.notEqual(workerAClaims[0].id, workerBClaims[0].id);
  await eventStore.markProcessed(workerAClaims[0].workspaceId, workerAClaims[0].id, "worker-a");
  await eventStore.markProcessed(workerBClaims[0].workspaceId, workerBClaims[0].id, "worker-b");

  const retryEvent = makeEvent("evt_pg_retry", owner.workspaceId, "retry-policy");
  await eventStore.accept(retryEvent);
  const [retryLease1] = await eventStore.claimNext("worker-retry-1", { limit: 1, workspaceId: owner.workspaceId });
  const retryResult = await eventStore.markFailed(retryLease1.workspaceId, retryLease1.id, "worker-retry-1", "temporary upstream error", { maxAttempts: 2, baseDelayMs: 30_000 });
  assert.equal(retryResult.status, "retrying");
  if (retryResult.status === "retrying") assert.ok(Date.parse(retryResult.retryAt) > Date.now());
  assert.equal((await eventStore.claimNext("worker-too-early", { limit: 1, workspaceId: owner.workspaceId })).length, 0);
  await pool.query(`UPDATE ${testSchema}.event_inbox SET next_attempt_at = '2000-01-01T00:00:00.000Z' WHERE id = $1`, [retryEvent.eventId]);
  const [retryLease2] = await eventStore.claimNext("worker-retry-2", { limit: 1, workspaceId: owner.workspaceId });
  assert.equal(retryLease2.id, retryEvent.eventId);
  assert.equal(retryLease2.attempt, 2);
  await eventStore.markProcessed(retryLease2.workspaceId, retryLease2.id, "worker-retry-2");

  const staleEvent = makeEvent("evt_pg_stale", owner.workspaceId, "stale-lease");
  await eventStore.accept(staleEvent);
  const [oldLease] = await eventStore.claimNext("worker-old", { limit: 1, workspaceId: owner.workspaceId });
  await pool.query(`UPDATE ${testSchema}.event_inbox SET processing_started_at = '2000-01-01T00:00:00.000Z' WHERE id = $1`, [staleEvent.eventId]);
  const [newLease] = await eventStore.claimNext("worker-new", { limit: 1, workspaceId: owner.workspaceId });
  assert.equal(newLease.id, staleEvent.eventId);
  assert.equal(newLease.attempt, 2);
  await assert.rejects(eventStore.markProcessed(oldLease.workspaceId, oldLease.id, "worker-old"), /lease was lost/);
  await eventStore.markProcessed(newLease.workspaceId, newLease.id, "worker-new");

  const failedEvent = makeEvent("evt_pg_dead_letter", owner.workspaceId, "dead-letter");
  await eventStore.accept(failedEvent);
  const [failedLease] = await eventStore.claimNext("worker-failure", { limit: 1, workspaceId: owner.workspaceId });
  const failure = await eventStore.markFailed(failedLease.workspaceId, failedLease.id, "worker-failure", "token=do-not-store", { maxAttempts: 1 });
  assert.equal(failure.status, "dead_letter");
  const deadLetter = await pool.query<{ id: string; reason: string }>(`SELECT id, reason FROM ${testSchema}.dead_letter_events WHERE event_id = $1`, [failedEvent.eventId]);
  assert.equal(deadLetter.rows[0]?.reason, "token=[REDACTED]");
  const replay = await eventStore.replayDeadLetter(owner.workspaceId, deadLetter.rows[0]!.id);
  assert.deepEqual(replay, { eventId: failedEvent.eventId });
  const [replayedLease] = await eventStore.claimNext("worker-replay", { limit: 1, workspaceId: owner.workspaceId });
  await eventStore.markProcessed(replayedLease.workspaceId, replayedLease.id, "worker-replay");

  await store.recordAuditEvent({ workspaceId: owner.workspaceId, actorUserId: owner.id, action: "postgres.identity_checked", entityType: "workspace", entityId: owner.workspaceId, metadata: { engine: "postgres" } });
  const [audit] = await store.listAuditEvents(owner.workspaceId, 1);
  assert.equal(audit.action, "postgres.identity_checked");
  assert.equal(audit.actor_email, "postgres-owner@example.com");
  assert.deepEqual(JSON.parse(audit.metadata_json), { engine: "postgres" });

  await store.updatePassword(owner.id, "updated-owner-password-123");
  assert.equal(await store.findSession(session.id), undefined);
  const migrations = await pool.query<{ version: number }>(`SELECT version FROM ${testSchema}.schema_migrations`);
  assert.deepEqual(migrations.rows.map((row) => row.version), [1, 2]);
  const domainTables = await pool.query<{ count: string }>(
    "SELECT COUNT(*)::text AS count FROM information_schema.tables WHERE table_schema = $1 AND table_type = 'BASE TABLE'",
    [testSchema],
  );
  assert.ok(Number(domainTables.rows[0]?.count) >= 27);

  console.log(JSON.stringify({ status: "passed", checks: ["repeatable-schema-migration", "domain-schema", "identity", "verification", "sessions", "workspace-session-constraint", "membership-isolation", "cross-workspace-domain-constraints", "optional-reference-tenant-preservation", "event-idempotency", "workspace-scoped-event-keys", "concurrent-worker-claims", "retry-scheduling", "stale-lease-fencing", "dead-letter-replay", "owner-invariant", "workspace-switch", "audit-provenance", "password-session-revocation"] }));
  } finally {
    await pool.query(`DROP SCHEMA IF EXISTS ${testSchema} CASCADE`).catch(() => undefined);
    await pool.end();
  }
}

main(connectionString).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
