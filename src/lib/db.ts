import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import { runMigrations } from "./migrations";

type ChangeRow = {
  id: string;
  sha: string;
  title: string;
  author: string;
  repository: string;
  url: string | null;
  created_at: string;
  risk_label: string;
};

const configuredDbPath = process.env.CHANGEGRAPH_DB_PATH?.trim();
const isNextProductionBuild = process.env.NEXT_PHASE === "phase-production-build";
const databasePath = isNextProductionBuild ? ":memory:" : configuredDbPath || path.join(process.cwd(), "data", "changegraph.db");
const dataDir = databasePath === ":memory:" ? path.join(process.cwd(), "data") : path.dirname(databasePath);
fs.mkdirSync(dataDir, { recursive: true });

const globalForDb = globalThis as unknown as { changegraphDb?: Database.Database };

export const db =
  globalForDb.changegraphDb ??
  new Database(databasePath);

if (process.env.NODE_ENV !== "production") globalForDb.changegraphDb = db;

db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    name TEXT NOT NULL,
    verified_at TEXT,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS workspaces (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    slug TEXT NOT NULL UNIQUE,
    mode TEXT NOT NULL DEFAULT 'production',
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS memberships (
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role TEXT NOT NULL DEFAULT 'member',
    created_at TEXT NOT NULL,
    PRIMARY KEY (workspace_id, user_id)
  );
  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS email_tokens (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    type TEXT NOT NULL,
    token TEXT NOT NULL UNIQUE,
    expires_at TEXT NOT NULL,
    used_at TEXT,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS services (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    slug TEXT NOT NULL,
    owner TEXT NOT NULL,
    status TEXT NOT NULL,
    health_score INTEGER NOT NULL,
    last_deploy_at TEXT,
    UNIQUE (workspace_id, slug)
  );
  CREATE TABLE IF NOT EXISTS changes (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    sha TEXT NOT NULL,
    title TEXT NOT NULL,
    author TEXT NOT NULL,
    repository TEXT NOT NULL,
    url TEXT,
    risk_label TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE (workspace_id, sha)
  );
  CREATE TABLE IF NOT EXISTS deployments (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    service_id TEXT NOT NULL REFERENCES services(id) ON DELETE CASCADE,
    change_id TEXT NOT NULL REFERENCES changes(id) ON DELETE CASCADE,
    version TEXT NOT NULL,
    environment TEXT NOT NULL,
    status TEXT NOT NULL,
    started_at TEXT NOT NULL,
    completed_at TEXT,
    url TEXT
  );
  CREATE TABLE IF NOT EXISTS incidents (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    key TEXT NOT NULL,
    title TEXT NOT NULL,
    service_id TEXT NOT NULL REFERENCES services(id) ON DELETE CASCADE,
    severity TEXT NOT NULL,
    status TEXT NOT NULL,
    started_at TEXT NOT NULL,
    detected_at TEXT NOT NULL,
    summary TEXT NOT NULL,
    impact TEXT NOT NULL,
    UNIQUE (workspace_id, key)
  );
  CREATE TABLE IF NOT EXISTS timeline_events (
    id TEXT PRIMARY KEY,
    incident_id TEXT NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
    occurred_at TEXT NOT NULL,
    type TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT NOT NULL,
    source_url TEXT,
    evidence_kind TEXT NOT NULL,
    evidence_ref TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS investigations (
    id TEXT PRIMARY KEY,
    incident_id TEXT NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
    status TEXT NOT NULL,
    confidence REAL NOT NULL,
    summary TEXT NOT NULL,
    evidence_json TEXT NOT NULL,
    tool_calls_json TEXT NOT NULL,
    next_checks_json TEXT NOT NULL,
    model TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS signals (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    incident_id TEXT REFERENCES incidents(id) ON DELETE SET NULL,
    kind TEXT NOT NULL,
    service_name TEXT NOT NULL,
    observed_at TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    source TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS evaluations (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    description TEXT NOT NULL,
    total_cases INTEGER NOT NULL,
    pass_rate REAL NOT NULL,
    last_run_at TEXT
  );
  CREATE TABLE IF NOT EXISTS evaluation_cases (
    id TEXT PRIMARY KEY,
    evaluation_id TEXT NOT NULL REFERENCES evaluations(id) ON DELETE CASCADE,
    incident_key TEXT NOT NULL,
    expected_cause TEXT NOT NULL,
    status TEXT NOT NULL,
    confidence REAL NOT NULL
  );
`);

runMigrations(db);

export function nowIso() {
  return new Date().toISOString();
}

export function recordAuditEvent(input: { workspaceId?: string | null; actorUserId?: string | null; action: string; entityType: string; entityId?: string | null; metadata?: unknown }) {
  db.prepare(
    "INSERT INTO audit_events (id, workspace_id, actor_user_id, action, entity_type, entity_id, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(`audit_${randomUUID().replaceAll("-", "").slice(0, 18)}`, input.workspaceId ?? null, input.actorUserId ?? null, input.action, input.entityType, input.entityId ?? null, JSON.stringify(input.metadata ?? {}), nowIso());
}

export function touchWorkerHeartbeat(workerName: string, result: { batchSize?: number; processedCount?: number; failedCount?: number; error?: string } = {}) {
  const timestamp = nowIso();
  db.prepare(
    `INSERT INTO worker_heartbeats (worker_name, last_seen_at, last_batch_size, last_processed_count, last_failed_count, last_error, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (worker_name) DO UPDATE SET
       last_seen_at = excluded.last_seen_at,
       last_batch_size = excluded.last_batch_size,
       last_processed_count = excluded.last_processed_count,
       last_failed_count = excluded.last_failed_count,
       last_error = excluded.last_error,
       updated_at = excluded.updated_at`,
  ).run(workerName, timestamp, result.batchSize ?? 0, result.processedCount ?? 0, result.failedCount ?? 0, result.error ?? null, timestamp);
}

export function getWorkerHeartbeat(workerName: string, staleAfterMs = 30_000) {
  const row = db.prepare("SELECT worker_name, last_seen_at, last_batch_size, last_processed_count, last_failed_count, last_error FROM worker_heartbeats WHERE worker_name = ?").get(workerName) as {
    worker_name: string;
    last_seen_at: string;
    last_batch_size: number;
    last_processed_count: number;
    last_failed_count: number;
    last_error: string | null;
  } | undefined;
  if (!row) return { status: "not_started" as const, lastSeenAt: null, lastBatchSize: 0, lastProcessedCount: 0, lastFailedCount: 0, lastError: null };
  const lastSeenAt = new Date(row.last_seen_at).getTime();
  const status = Number.isFinite(lastSeenAt) && Date.now() - lastSeenAt <= staleAfterMs ? "healthy" : "stale";
  return { status: status as "healthy" | "stale", lastSeenAt: row.last_seen_at, lastBatchSize: row.last_batch_size, lastProcessedCount: row.last_processed_count, lastFailedCount: row.last_failed_count, lastError: row.last_error };
}

export function getOperationalMetrics(workspaceId: string) {
  const scalar = (query: string, ...params: Array<string | number>) => Number((db.prepare(query).get(...params) as { count: number }).count);
  return {
    services: scalar("SELECT COUNT(*) AS count FROM services WHERE workspace_id = ?", workspaceId),
    openIncidents: scalar("SELECT COUNT(*) AS count FROM incidents WHERE workspace_id = ? AND status NOT IN ('resolved', 'closed')", workspaceId),
    recentDeployments: countRecentDeployments(workspaceId),
    telemetryReferences: scalar("SELECT COUNT(*) AS count FROM telemetry_references WHERE workspace_id = ?", workspaceId),
    eventInbox: {
      received: scalar("SELECT COUNT(*) AS count FROM event_inbox WHERE workspace_id = ? AND status = 'received'", workspaceId),
      processing: scalar("SELECT COUNT(*) AS count FROM event_inbox WHERE workspace_id = ? AND status = 'processing'", workspaceId),
      retrying: scalar("SELECT COUNT(*) AS count FROM event_inbox WHERE workspace_id = ? AND status = 'retrying'", workspaceId),
      processed: scalar("SELECT COUNT(*) AS count FROM event_inbox WHERE workspace_id = ? AND status = 'processed'", workspaceId),
      deadLetter: scalar("SELECT COUNT(*) AS count FROM event_inbox WHERE workspace_id = ? AND status = 'dead_letter'", workspaceId),
    },
    deadLetters: scalar("SELECT COUNT(*) AS count FROM dead_letter_events WHERE workspace_id = ?", workspaceId),
  };
}

function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

function ago(minutes: number) {
  return new Date(Date.now() - minutes * 60_000).toISOString();
}

export function seedDemoData() {
  const existing = db.prepare("SELECT id FROM workspaces WHERE slug = ?").get("northstar-demo") as
    | { id: string }
    | undefined;
  if (existing) {
    seedDemoAugmentations(existing.id);
    return existing.id;
  }

  const workspaceId = "ws_northstar_demo";
  const userId = "usr_demo";
  const checkoutId = "svc_checkout";
  const paymentsId = "svc_payments";
  const edgeId = "svc_edge";
  const changeId = "chg_9a7c2d1";
  const deployId = "dep_2024_11_07_01";
  const incidentId = "inc_1047";
  const evalId = "eval_regression_suite";
  const timestamp = nowIso();

  const seed = db.transaction(() => {
    db.prepare(
      "INSERT INTO users (id, email, password_hash, name, verified_at, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(
      userId,
      "demo@changegraph.dev",
      bcrypt.hashSync("demo1234", 10),
      "Alex Morgan",
      timestamp,
      timestamp,
    );
    db.prepare(
      "INSERT INTO workspaces (id, name, slug, mode, created_at) VALUES (?, ?, ?, ?, ?)",
    ).run(workspaceId, "Northstar Platform", "northstar-demo", "demo", timestamp);
    db.prepare(
      "INSERT INTO memberships (workspace_id, user_id, role, created_at) VALUES (?, ?, ?, ?)",
    ).run(workspaceId, userId, "owner", timestamp);

    const service = db.prepare(
      "INSERT INTO services (id, workspace_id, name, slug, owner, status, health_score, last_deploy_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    );
    service.run(checkoutId, workspaceId, "checkout-api", "checkout-api", "Payments", "degraded", 68, ago(42));
    service.run(paymentsId, workspaceId, "payments-worker", "payments-worker", "Payments", "healthy", 98, ago(195));
    service.run(edgeId, workspaceId, "edge-gateway", "edge-gateway", "Core Infra", "healthy", 99, ago(320));

    db.prepare(
      "INSERT INTO changes (id, workspace_id, sha, title, author, repository, url, risk_label, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
      changeId,
      workspaceId,
      "9a7c2d1",
      "Add retry budget to checkout client",
      "Priya Shah",
      "northstar/checkout-api",
      "https://github.com/northstar/checkout-api/commit/9a7c2d1",
      "elevated",
      ago(58),
    );
    db.prepare(
      "INSERT INTO deployments (id, workspace_id, service_id, change_id, version, environment, status, started_at, completed_at, url) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
      deployId,
      workspaceId,
      checkoutId,
      changeId,
      "checkout-api@2024.11.07.3",
      "production",
      "completed",
      ago(51),
      ago(48),
      "https://github.com/northstar/checkout-api/actions/runs/22104",
    );
    db.prepare(
      "INSERT INTO incidents (id, workspace_id, key, title, service_id, severity, status, started_at, detected_at, summary, impact) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
      incidentId,
      workspaceId,
      "INC-1047",
      "Checkout latency spike",
      checkoutId,
      "SEV-2",
      "investigating",
      ago(47),
      ago(44),
      "p95 checkout latency rose from 420ms to 2.8s shortly after the latest production deployment.",
      "Card checkout success is down 8.4% for US traffic. No confirmed data loss.",
    );

    const event = db.prepare(
      "INSERT INTO timeline_events (id, incident_id, occurred_at, type, title, description, source_url, evidence_kind, evidence_ref) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    );
    event.run("evt_01", incidentId, ago(47), "detected", "Health signal crossed threshold", "checkout-api p95 exceeded the 1.2s SLO for five consecutive minutes.", "https://grafana.example.com/d/checkout", "metric", "checkout-api.latency.p95");
    event.run("evt_02", incidentId, ago(44), "correlated", "Incident opened", "Pager policy created INC-1047 from the checkout latency alert.", "https://pagerduty.example.com/incidents/INC-1047", "alert", "pd:INC-1047");
    event.run("evt_03", incidentId, ago(42), "change", "Production deployment completed", "Version checkout-api@2024.11.07.3 reached 100% of production pods.", "https://github.com/northstar/checkout-api/actions/runs/22104", "deployment", deployId);
    event.run("evt_04", incidentId, ago(39), "trace", "Slow span pattern observed", "checkout.payment_authorize shows elevated retries and 3.1s median duration.", "https://trace.example.com/checkout/payment_authorize", "trace", "span:checkout.payment_authorize");
    event.run("evt_05", incidentId, ago(31), "log", "Retry budget warning in logs", "retry_budget_exhausted count increased 11x in checkout-api pods after rollout.", "https://logs.example.com/search?q=retry_budget_exhausted", "log", "log:retry_budget_exhausted");
    event.run("evt_06", incidentId, ago(16), "runbook", "Runbook check suggested", "Validate retry backoff configuration and compare authorize error rate by provider.", "https://runbooks.example.com/checkout-latency", "runbook", "rb:checkout-latency");

    db.prepare(
      "INSERT INTO investigations (id, incident_id, status, confidence, summary, evidence_json, tool_calls_json, next_checks_json, model, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
      "inv_1047_baseline",
      incidentId,
      "uncertain",
      0.78,
      "The latest checkout-api deployment is the leading hypothesis, with retry budget exhaustion as the most plausible mechanism. Evidence is temporally aligned but does not prove causality.",
      JSON.stringify([
        { ref: "deployment:dep_2024_11_07_01", label: "Deployment completed 42m before investigation", weight: 0.82, kind: "deployment" },
        { ref: "metric:checkout-api.latency.p95", label: "p95 latency crossed SLO for 5m", weight: 0.77, kind: "metric" },
        { ref: "log:retry_budget_exhausted", label: "Retry budget exhaustion rose 11x", weight: 0.74, kind: "log" },
        { ref: "trace:span:checkout.payment_authorize", label: "authorize spans slowed and retried", weight: 0.69, kind: "trace" },
      ]),
      JSON.stringify([
        { name: "fetch_recent_changes", detail: "Looked up changes and deployments for checkout-api in the incident window." },
        { name: "compare_health_signals", detail: "Compared p95 latency, retry budget logs, and authorize trace duration." },
        { name: "retrieve_runbook", detail: "Loaded the checkout latency runbook and extracted the first validation steps." },
      ]),
      JSON.stringify([
        "Compare retry backoff configuration before and after 9a7c2d1.",
        "Run a 5-minute canary rollback on 10% of checkout-api traffic.",
        "Break down authorize latency by payment provider to test for a shared upstream issue.",
      ]),
      "changegraph-baseline-v1",
      ago(5),
    );

    db.prepare(
      "INSERT INTO signals (id, workspace_id, incident_id, kind, service_name, observed_at, payload_json, source) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).run("sig_01", workspaceId, incidentId, "metric", "checkout-api", ago(44), JSON.stringify({ metric: "http.server.duration.p95", value: 2800, unit: "ms" }), "demo-seed");
    db.prepare(
      "INSERT INTO signals (id, workspace_id, incident_id, kind, service_name, observed_at, payload_json, source) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).run("sig_02", workspaceId, incidentId, "log", "checkout-api", ago(31), JSON.stringify({ message: "retry_budget_exhausted", count: 114 }), "demo-seed");

    db.prepare(
      "INSERT INTO evaluations (id, workspace_id, name, description, total_cases, pass_rate, last_run_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run(evalId, workspaceId, "Regression / known-cause suite", "Seeded incidents with known change, dependency, and telemetry causes.", 12, 0.83, ago(118));
    const evalCase = db.prepare(
      "INSERT INTO evaluation_cases (id, evaluation_id, incident_key, expected_cause, status, confidence) VALUES (?, ?, ?, ?, ?, ?)",
    );
    evalCase.run("case_1047", evalId, "INC-1047", "9a7c2d1 / retry budget", "pass", 0.78);
    evalCase.run("case_1038", evalId, "INC-1038", "payments-worker dependency", "pass", 0.71);
    evalCase.run("case_1029", evalId, "INC-1029", "upstream provider", "review", 0.46);
  });
  seed();
  seedDemoAugmentations(workspaceId);
  return workspaceId;
}

function seedDemoAugmentations(workspaceId: string) {
  const timestamp = nowIso();
  const augment = db.transaction(() => {
    // Keep the local demo reproducible after the database has been left running for a while.
    // Demo workspaces are explicitly sample data, so refreshing these relative timestamps is safe.
    db.prepare("UPDATE changes SET created_at = ? WHERE workspace_id = ? AND id = 'chg_9a7c2d1'").run(ago(58), workspaceId);
    db.prepare("UPDATE deployments SET started_at = ?, completed_at = ? WHERE workspace_id = ? AND id = 'dep_2024_11_07_01'").run(ago(51), ago(48), workspaceId);
    db.prepare("UPDATE services SET last_deploy_at = ? WHERE workspace_id = ? AND id = 'svc_checkout'").run(ago(42), workspaceId);
    db.prepare("UPDATE incidents SET started_at = ?, detected_at = ? WHERE workspace_id = ? AND id = 'inc_1047'").run(ago(47), ago(44), workspaceId);
    db.prepare("UPDATE incidents SET started_at = ?, detected_at = ? WHERE workspace_id = ? AND id = 'inc_1038'").run(ago(500), ago(495), workspaceId);
    db.prepare("UPDATE incidents SET started_at = ?, detected_at = ? WHERE workspace_id = ? AND id = 'inc_1029'").run(ago(800), ago(795), workspaceId);
    const timelineTimes: Record<string, number> = { evt_01: 47, evt_02: 44, evt_03: 42, evt_04: 39, evt_05: 31, evt_06: 16, evt_1038_dependency: 492 };
    for (const [eventId, minutes] of Object.entries(timelineTimes)) {
      db.prepare("UPDATE timeline_events SET occurred_at = ? WHERE id = ? AND incident_id IN ('inc_1047', 'inc_1038')").run(ago(minutes), eventId);
    }
    const telemetryTimes: Record<string, number> = { tel_demo_metric: 44, tel_demo_trace: 39, tel_demo_log: 31 };
    for (const [telemetryId, minutes] of Object.entries(telemetryTimes)) {
      db.prepare("UPDATE telemetry_references SET observed_at = ? WHERE workspace_id = ? AND id = ?").run(ago(minutes), workspaceId, telemetryId);
    }
    db.prepare(
      "INSERT OR IGNORE INTO service_dependencies (workspace_id, upstream_service_id, downstream_service_id, dependency_kind, created_at) VALUES (?, ?, ?, ?, ?)",
    ).run(workspaceId, "svc_payments", "svc_checkout", "runtime", timestamp);
    db.prepare(
      "INSERT OR IGNORE INTO service_dependencies (workspace_id, upstream_service_id, downstream_service_id, dependency_kind, created_at) VALUES (?, ?, ?, ?, ?)",
    ).run(workspaceId, "svc_edge", "svc_checkout", "runtime", timestamp);
    db.prepare(
      "INSERT OR IGNORE INTO incidents (id, workspace_id, key, title, service_id, severity, status, started_at, detected_at, summary, impact) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run("inc_1038", workspaceId, "INC-1038", "Checkout queue dependency lag", "svc_checkout", "SEV-3", "resolved", ago(500), ago(495), "A transient payments-worker degradation overlapped checkout queue latency.", "Checkout processing slowed for a limited window; no data loss was observed.");
    db.prepare(
      "INSERT OR IGNORE INTO incidents (id, workspace_id, key, title, service_id, severity, status, started_at, detected_at, summary, impact) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run("inc_1029", workspaceId, "INC-1029", "Provider authorization variance", "svc_checkout", "SEV-3", "resolved", ago(800), ago(795), "Provider-specific authorization latency varied without a correlated deployment.", "A small traffic segment saw elevated latency; the cause was not confirmed.");
    db.prepare(
      "INSERT OR IGNORE INTO timeline_events (id, incident_id, occurred_at, type, title, description, source_url, evidence_kind, evidence_ref) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run("evt_1038_dependency", "inc_1038", ago(492), "correlated", "Dependency health changed", "payments-worker error rate rose during the checkout incident window.", "https://grafana.example.com/d/payments", "metric", "sig_1038_dependency");
    const telemetry = db.prepare(
      "INSERT OR IGNORE INTO telemetry_references (id, workspace_id, incident_id, service_id, signal_kind, external_ref, observed_at, summary, source_url, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    );
    telemetry.run("tel_demo_metric", workspaceId, "inc_1047", "svc_checkout", "metric", "checkout-api.latency.p95", ago(44), "p95 latency crossed the checkout SLO for five minutes.", "https://grafana.example.com/d/checkout", JSON.stringify({ value: 2800, unit: "ms" }), timestamp);
    telemetry.run("tel_demo_trace", workspaceId, "inc_1047", "svc_checkout", "trace", "span:checkout.payment_authorize", ago(39), "Authorize spans slowed and retried after the rollout.", "https://trace.example.com/checkout/payment_authorize", JSON.stringify({ durationMs: 3100, retries: 4 }), timestamp);
    telemetry.run("tel_demo_log", workspaceId, "inc_1047", "svc_checkout", "log", "log:retry_budget_exhausted", ago(31), "Retry budget exhaustion increased 11x in checkout-api pods.", "https://logs.example.com/search?q=retry_budget_exhausted", JSON.stringify({ count: 114 }), timestamp);
    const signal = db.prepare(
      "INSERT OR IGNORE INTO signals (id, workspace_id, incident_id, kind, service_name, observed_at, payload_json, source) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    );
    signal.run("sig_baseline_checkout_01", workspaceId, null, "metric", "checkout-api", ago(1440), JSON.stringify({ metric: "http.server.duration.p95", value: 420, unit: "ms" }), "demo-seed");
    signal.run("sig_baseline_checkout_02", workspaceId, null, "metric", "checkout-api", ago(720), JSON.stringify({ metric: "http.server.duration.p95", value: 460, unit: "ms" }), "demo-seed");
    signal.run("sig_baseline_checkout_03", workspaceId, null, "metric", "checkout-api", ago(360), JSON.stringify({ metric: "http.server.error_rate", value: 0.008, unit: "ratio" }), "demo-seed");
    signal.run("sig_baseline_checkout_04", workspaceId, null, "metric", "checkout-api", ago(240), JSON.stringify({ metric: "slo.availability", value: 0.995, unit: "ratio" }), "demo-seed");
    signal.run("sig_03", workspaceId, "inc_1047", "metric", "checkout-api", ago(43), JSON.stringify({ metric: "http.server.error_rate", value: 0.084, unit: "ratio" }), "demo-seed");
    signal.run("sig_04", workspaceId, "inc_1047", "metric", "checkout-api", ago(42), JSON.stringify({ metric: "slo.availability", value: 0.914, unit: "ratio" }), "demo-seed");
    signal.run("sig_baseline_payments_01", workspaceId, null, "metric", "payments-worker", ago(1440), JSON.stringify({ metric: "http.server.error_rate", value: 0.01, unit: "ratio" }), "demo-seed");
    signal.run("sig_baseline_payments_02", workspaceId, null, "metric", "payments-worker", ago(720), JSON.stringify({ metric: "http.server.error_rate", value: 0.012, unit: "ratio" }), "demo-seed");
    signal.run("sig_1038_dependency", workspaceId, "inc_1038", "metric", "payments-worker", ago(492), JSON.stringify({ metric: "http.server.error_rate", value: 0.12, unit: "ratio" }), "demo-seed");
    const detectionTimes = db.prepare("SELECT id, detected_at FROM incidents WHERE workspace_id = ? AND id IN ('inc_1047', 'inc_1038')").all(workspaceId) as Array<{ id: string; detected_at: string }>;
    for (const incident of detectionTimes) {
      const offset = incident.id === "inc_1038" ? 2 : 1;
      const observedAt = new Date(new Date(incident.detected_at).getTime() - offset * 60_000).toISOString();
      if (incident.id === "inc_1038") db.prepare("UPDATE signals SET observed_at = ? WHERE workspace_id = ? AND id = 'sig_1038_dependency'").run(observedAt, workspaceId);
      else {
        db.prepare("UPDATE signals SET observed_at = ? WHERE workspace_id = ? AND id = 'sig_01'").run(observedAt, workspaceId);
        db.prepare("UPDATE signals SET observed_at = ? WHERE workspace_id = ? AND id = 'sig_03'").run(new Date(new Date(incident.detected_at).getTime() - 2 * 60_000).toISOString(), workspaceId);
        db.prepare("UPDATE signals SET observed_at = ? WHERE workspace_id = ? AND id = 'sig_04'").run(new Date(new Date(incident.detected_at).getTime() - 90_000).toISOString(), workspaceId);
      }
    }
    db.prepare(
      "INSERT OR IGNORE INTO hypotheses (id, workspace_id, incident_id, title, summary, status, confidence, is_abstention, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run("hyp_1047_primary", workspaceId, "inc_1047", "Latest checkout deployment is the leading hypothesis", "Temporal alignment between the faulty deployment and the latency, trace, and retry signals is strong enough to guide checks, but it does not prove causality.", "uncertain", 0.78, 0, "changegraph-baseline-v1", timestamp, timestamp);
    db.prepare(
      "INSERT OR IGNORE INTO hypothesis_evidence (id, workspace_id, hypothesis_id, evidence_kind, evidence_ref, relationship, weight, source_url, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run("hyp_evidence_deployment", workspaceId, "hyp_1047_primary", "deployment", "dep_2024_11_07_01", "temporally aligned with incident onset", 0.82, "https://github.com/northstar/checkout-api/actions/runs/22104", timestamp);
    db.prepare(
      "INSERT OR IGNORE INTO hypothesis_evidence (id, workspace_id, hypothesis_id, evidence_kind, evidence_ref, relationship, weight, source_url, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run("hyp_evidence_metric", workspaceId, "hyp_1047_primary", "metric", "checkout-api.latency.p95", "health degradation followed rollout", 0.77, "https://grafana.example.com/d/checkout", timestamp);
    db.prepare(
      "INSERT OR IGNORE INTO hypothesis_evidence (id, workspace_id, hypothesis_id, evidence_kind, evidence_ref, relationship, weight, source_url, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run("hyp_evidence_log", workspaceId, "hyp_1047_primary", "log", "log:retry_budget_exhausted", "mechanism is plausible but unverified", 0.74, "https://logs.example.com/search?q=retry_budget_exhausted", timestamp);
    db.prepare(
      "INSERT OR IGNORE INTO integrations (id, workspace_id, provider, status, display_name, config_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).run("int_demo_github", workspaceId, "github", "demo_only", "GitHub", JSON.stringify({ sampleData: true }), timestamp, timestamp);
    db.prepare(
      "INSERT OR IGNORE INTO integrations (id, workspace_id, provider, status, display_name, config_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).run("int_demo_otel", workspaceId, "otel", "demo_only", "OpenTelemetry", JSON.stringify({ sampleData: true }), timestamp, timestamp);
    db.prepare(
      "INSERT OR IGNORE INTO integrations (id, workspace_id, provider, status, display_name, config_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).run("int_demo_runbook", workspaceId, "runbook", "demo_only", "Runbooks", JSON.stringify({ sampleData: true }), timestamp, timestamp);
    db.prepare(
      "INSERT OR IGNORE INTO audit_events (id, workspace_id, actor_user_id, action, entity_type, entity_id, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).run("audit_demo_seed", workspaceId, null, "demo.seeded", "workspace", workspaceId, JSON.stringify({ sampleData: true, faultyDeployment: "dep_2024_11_07_01" }), timestamp);
    db.prepare(
      "INSERT OR IGNORE INTO runbooks (id, workspace_id, service_id, slug, title, summary, url, content, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run("rb_checkout_latency", workspaceId, "svc_checkout", "checkout-latency", "Checkout latency response", "Validate retry backoff and compare authorization latency by provider before rolling back.", "https://runbooks.example.com/checkout-latency", "1. Compare retry backoff before and after the candidate deployment.\n2. Break down authorization latency by provider.\n3. Run a small canary rollback before declaring causality.", timestamp, timestamp);
    const evaluationRuns = db.prepare("SELECT COUNT(*) AS count FROM evaluation_runs WHERE workspace_id = ? AND evaluation_id = ?").get(workspaceId, "eval_regression_suite") as { count: number };
    if (evaluationRuns.count === 0) {
      db.prepare("UPDATE evaluations SET total_cases = ?, pass_rate = ?, last_run_at = NULL WHERE workspace_id = ? AND id = ?").run(3, 0, workspaceId, "eval_regression_suite");
      db.prepare("UPDATE evaluation_cases SET expected_abstention = CASE WHEN incident_key = 'INC-1029' THEN 1 ELSE 0 END WHERE evaluation_id = ?").run("eval_regression_suite");
    }
  });
  augment();
}

export function getDemoUser() {
  return db.prepare("SELECT id, email, name, verified_at FROM users WHERE email = ?").get("demo@changegraph.dev") as {
    id: string;
    email: string;
    name: string;
    verified_at: string | null;
  };
}

export function getWorkspaceForUser(userId: string, workspaceId?: string) {
  return (workspaceId
    ? db.prepare(
        `SELECT w.*, m.role FROM workspaces w JOIN memberships m ON m.workspace_id = w.id WHERE w.id = ? AND m.user_id = ?`,
      ).get(workspaceId, userId)
    : db
        .prepare(
          `SELECT w.*, m.role FROM workspaces w JOIN memberships m ON m.workspace_id = w.id WHERE m.user_id = ? ORDER BY w.created_at ASC LIMIT 1`,
        )
        .get(userId)) as
    | { id: string; name: string; slug: string; mode: string; role: string; created_at: string }
    | undefined;
}

export function getWorkspaceById(workspaceId: string) {
  return db.prepare("SELECT * FROM workspaces WHERE id = ?").get(workspaceId) as
    | { id: string; name: string; slug: string; mode: string; created_at: string }
    | undefined;
}

export function getUserWorkspaces(userId: string) {
  return db
    .prepare(
      `SELECT w.id, w.name, w.slug, w.mode, m.role FROM workspaces w JOIN memberships m ON m.workspace_id = w.id WHERE m.user_id = ? ORDER BY w.created_at ASC`,
    )
    .all(userId) as Array<{ id: string; name: string; slug: string; mode: string; role: string }>;
}

export function switchSessionWorkspace(sessionId: string, userId: string, workspaceId: string) {
  const membership = db
    .prepare("SELECT workspace_id FROM memberships WHERE workspace_id = ? AND user_id = ?")
    .get(workspaceId, userId) as { workspace_id: string } | undefined;
  if (!membership) return false;
  db.prepare("UPDATE sessions SET workspace_id = ? WHERE id = ? AND user_id = ?").run(workspaceId, sessionId, userId);
  return true;
}

export function listWorkspaceMembers(workspaceId: string) {
  return db
    .prepare(
      `SELECT u.id, u.name, u.email, u.verified_at, m.role, m.created_at FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.workspace_id = ? ORDER BY m.created_at ASC`,
    )
    .all(workspaceId) as Array<{ id: string; name: string; email: string; verified_at: string | null; role: string; created_at: string }>;
}

export function listAuditEvents(workspaceId: string, limit = 40) {
  return db.prepare(
    `SELECT a.id, a.action, a.entity_type, a.entity_id, a.metadata_json, a.created_at, u.name AS actor_name, u.email AS actor_email
     FROM audit_events a LEFT JOIN users u ON u.id = a.actor_user_id
     WHERE a.workspace_id = ? ORDER BY a.created_at DESC LIMIT ?`,
  ).all(workspaceId, Math.min(100, Math.max(1, limit))) as Array<{ id: string; action: string; entity_type: string; entity_id: string | null; metadata_json: string; created_at: string; actor_name: string | null; actor_email: string | null }>;
}

export function addWorkspaceMember(workspaceId: string, email: string, role: string) {
  const user = getUserByEmail(email);
  if (!user) return { ok: false as const, reason: "not_found" as const };
  const inserted = db.prepare("INSERT INTO memberships (workspace_id, user_id, role, created_at) VALUES (?, ?, ?, ?) ON CONFLICT (workspace_id, user_id) DO NOTHING")
    .run(workspaceId, user.id, role, nowIso());
  if (inserted.changes === 0) return { ok: false as const, reason: "exists" as const };
  return { ok: true as const, userId: user.id };
}

export function updateWorkspaceMemberRole(workspaceId: string, userId: string, role: string) {
  return db.transaction(() => {
    const current = db.prepare("SELECT role FROM memberships WHERE workspace_id = ? AND user_id = ?").get(workspaceId, userId) as { role: string } | undefined;
    if (!current || (current.role === "owner" && role !== "owner")) return false;
    if (role === "owner") {
      const owner = db.prepare("SELECT user_id FROM memberships WHERE workspace_id = ? AND role = 'owner'").get(workspaceId) as { user_id: string } | undefined;
      if (owner && owner.user_id !== userId) return false;
    }
    return db.prepare("UPDATE memberships SET role = ? WHERE workspace_id = ? AND user_id = ?").run(role, workspaceId, userId).changes > 0;
  })();
}

export function removeWorkspaceMember(workspaceId: string, userId: string) {
  const owner = db.prepare("SELECT user_id FROM memberships WHERE workspace_id = ? AND role = 'owner'").get(workspaceId) as { user_id: string } | undefined;
  if (owner?.user_id === userId) return false;
  return db.prepare("DELETE FROM memberships WHERE workspace_id = ? AND user_id = ?").run(workspaceId, userId).changes > 0;
}

export function updateUserName(userId: string, name: string) {
  db.prepare("UPDATE users SET name = ? WHERE id = ?").run(name.trim(), userId);
}

export function updateWorkspace(workspaceId: string, input: { name: string; mode: string }) {
  db.prepare("UPDATE workspaces SET name = ?, mode = ? WHERE id = ?").run(input.name.trim(), input.mode, workspaceId);
}

export function createWorkspace(userId: string, input: { name: string; mode: string }) {
  const id = `ws_${randomUUID().slice(0, 8)}`;
  const timestamp = nowIso();
  const slug = `${input.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 36) || "workspace"}-${id.slice(-4)}`;
  const tx = db.transaction(() => {
    db.prepare("INSERT INTO workspaces (id, name, slug, mode, created_at) VALUES (?, ?, ?, ?, ?)").run(id, input.name.trim(), slug, input.mode, timestamp);
    db.prepare("INSERT INTO memberships (workspace_id, user_id, role, created_at) VALUES (?, ?, ?, ?)").run(id, userId, "owner", timestamp);
  });
  tx();
  return { id, slug };
}

export function seedIfNeeded() {
  if (process.env.NODE_ENV === "production" && process.env.CHANGEGRAPH_SEED_DEMO !== "true") return "";
  return seedDemoData();
}

export type IncidentRow = {
  id: string;
  key: string;
  title: string;
  service_id: string;
  service_name: string;
  severity: string;
  status: string;
  started_at: string;
  detected_at: string;
  summary: string;
  impact: string;
};

export function listIncidents(workspaceId: string) {
  return db
    .prepare(
      `SELECT i.*, s.name AS service_name FROM incidents i JOIN services s ON s.id = i.service_id WHERE i.workspace_id = ? ORDER BY i.detected_at DESC`,
    )
    .all(workspaceId) as IncidentRow[];
}

export type IncidentQuery = {
  query?: string;
  status?: string;
  severity?: string;
  page?: number;
  pageSize?: number;
};

export function queryIncidents(workspaceId: string, input: IncidentQuery = {}) {
  const pageSize = Math.min(50, Math.max(1, input.pageSize ?? 8));
  const page = Math.max(1, input.page ?? 1);
  const where = ["i.workspace_id = ?"];
  const params: Array<string | number> = [workspaceId];
  const query = input.query?.trim();
  if (query) {
    where.push("(i.key LIKE ? OR i.title LIKE ? OR i.summary LIKE ? OR i.impact LIKE ? OR s.name LIKE ?)");
    const pattern = `%${query}%`;
    params.push(pattern, pattern, pattern, pattern, pattern);
  }
  if (input.status && input.status !== "all") {
    where.push("i.status = ?");
    params.push(input.status);
  }
  if (input.severity && input.severity !== "all") {
    where.push("i.severity = ?");
    params.push(input.severity);
  }
  const clause = where.join(" AND ");
  const total = (db.prepare(`SELECT COUNT(*) AS count FROM incidents i JOIN services s ON s.id = i.service_id AND s.workspace_id = i.workspace_id WHERE ${clause}`).get(...params) as { count: number }).count;
  const items = db.prepare(`SELECT i.*, s.name AS service_name FROM incidents i JOIN services s ON s.id = i.service_id AND s.workspace_id = i.workspace_id WHERE ${clause} ORDER BY i.detected_at DESC LIMIT ? OFFSET ?`).all(...params, pageSize, (page - 1) * pageSize) as IncidentRow[];
  return { items, total, page, pageSize, pageCount: Math.max(1, Math.ceil(total / pageSize)) };
}

export function getIncident(workspaceId: string, incidentId: string) {
  return db
    .prepare(
      `SELECT i.*, s.name AS service_name, s.owner AS service_owner FROM incidents i JOIN services s ON s.id = i.service_id WHERE i.workspace_id = ? AND i.id = ?`,
    )
    .get(workspaceId, incidentId) as (IncidentRow & { service_owner: string }) | undefined;
}

export function getIncidentTimeline(workspaceId: string, incidentId: string) {
  return db
    .prepare("SELECT te.* FROM timeline_events te JOIN incidents i ON i.id = te.incident_id WHERE i.workspace_id = ? AND te.incident_id = ? ORDER BY te.occurred_at ASC")
    .all(workspaceId, incidentId) as Array<{
    id: string;
    occurred_at: string;
    type: string;
    title: string;
    description: string;
    source_url: string | null;
    evidence_kind: string;
    evidence_ref: string;
  }>;
}

export function getInvestigation(workspaceId: string, incidentId: string) {
  const row = db.prepare("SELECT inv.* FROM investigations inv JOIN incidents i ON i.id = inv.incident_id WHERE i.workspace_id = ? AND inv.incident_id = ? ORDER BY inv.created_at DESC LIMIT 1").get(workspaceId, incidentId) as
    | {
        id: string;
        status: string;
        confidence: number;
        summary: string;
        evidence_json: string;
        tool_calls_json: string;
        next_checks_json: string;
        model: string;
        created_at: string;
      }
    | undefined;
  if (!row) return null;
  const structured = JSON.parse(row.evidence_json) as { evidence?: Array<{ ref: string; label: string; weight: number; kind: string }>; hypotheses?: unknown[]; summaryEvidenceRefs?: string[]; uncertainty?: string } | Array<{ ref: string; label: string; weight: number; kind: string }>;
  const evidence = Array.isArray(structured) ? structured : structured.evidence ?? [];
  return {
    ...row,
    createdAt: row.created_at,
    evidence,
    hypotheses: Array.isArray(structured) ? [] : structured.hypotheses ?? [],
    summaryEvidenceRefs: Array.isArray(structured) ? evidence.map((item) => item.ref) : structured.summaryEvidenceRefs ?? [],
    uncertainty: Array.isArray(structured) ? "Temporal correlation is not proof of causality." : structured.uncertainty ?? "Temporal correlation is not proof of causality.",
    toolCalls: JSON.parse(row.tool_calls_json) as Array<{ name: string; detail: string }>,
    nextChecks: JSON.parse(row.next_checks_json) as string[],
  };
}

export function getInvestigationHistory(workspaceId: string, incidentId: string) {
  const rows = db.prepare("SELECT inv.id, inv.status, inv.confidence, inv.summary, inv.next_checks_json, inv.model, inv.created_at FROM investigations inv JOIN incidents i ON i.id = inv.incident_id WHERE i.workspace_id = ? AND inv.incident_id = ? ORDER BY inv.created_at DESC").all(workspaceId, incidentId) as Array<{ id: string; status: string; confidence: number; summary: string; next_checks_json: string; model: string; created_at: string }>;
  return rows.map((row) => ({ id: row.id, status: row.status, confidence: row.confidence, summary: row.summary, nextChecks: JSON.parse(row.next_checks_json) as string[], model: row.model, createdAt: row.created_at }));
}

export function listServices(workspaceId: string) {
  return db.prepare("SELECT * FROM services WHERE workspace_id = ? ORDER BY name").all(workspaceId) as Array<{
    id: string;
    name: string;
    slug: string;
    owner: string;
    status: string;
    health_score: number;
    last_deploy_at: string | null;
  }>;
}

export function getServiceHealthTrend(workspaceId: string, serviceName: string, limit = 18) {
  const rows = db.prepare("SELECT id, incident_id, kind, observed_at, payload_json, source FROM signals WHERE workspace_id = ? AND service_name = ? ORDER BY observed_at DESC LIMIT ?").all(workspaceId, serviceName, Math.min(48, Math.max(1, limit))) as Array<{ id: string; incident_id: string | null; kind: string; observed_at: string; payload_json: string; source: string }>;
  return rows.reverse().map((row) => {
    let payload: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(row.payload_json) as unknown;
      if (typeof parsed === "object" && parsed !== null) payload = parsed as Record<string, unknown>;
    } catch {
      payload = {};
    }
    const metric = typeof payload.metric === "string" ? payload.metric : typeof payload.metricName === "string" ? payload.metricName : row.kind;
    const rawValue = payload.value ?? payload.asDouble ?? payload.latencyMs ?? payload.errorRate ?? payload.availability;
    const value = typeof rawValue === "number" && Number.isFinite(rawValue) ? rawValue : null;
    return { id: row.id, incidentId: row.incident_id, kind: row.kind, observedAt: row.observed_at, metric, value, source: row.source };
  });
}

export function getServiceDependencies(workspaceId: string) {
  return db.prepare(`SELECT sd.upstream_service_id, sd.downstream_service_id, sd.dependency_kind, upstream.name AS upstream_name, upstream.slug AS upstream_slug, downstream.name AS downstream_name, downstream.slug AS downstream_slug FROM service_dependencies sd JOIN services upstream ON upstream.id = sd.upstream_service_id AND upstream.workspace_id = sd.workspace_id JOIN services downstream ON downstream.id = sd.downstream_service_id AND downstream.workspace_id = sd.workspace_id WHERE sd.workspace_id = ? ORDER BY downstream.name, upstream.name`).all(workspaceId) as Array<{ upstream_service_id: string; downstream_service_id: string; dependency_kind: string; upstream_name: string; upstream_slug: string; downstream_name: string; downstream_slug: string }>;
}

export function listServiceChanges(workspaceId: string, serviceId: string, limit = 8) {
  return db.prepare(`SELECT d.id AS deployment_id, d.version, d.environment, d.status, d.started_at, d.completed_at, d.url, c.id AS change_id, c.sha, c.title, c.author, c.repository, c.url AS change_url, c.risk_label FROM deployments d JOIN changes c ON c.id = d.change_id AND c.workspace_id = d.workspace_id WHERE d.workspace_id = ? AND d.service_id = ? ORDER BY d.started_at DESC LIMIT ?`).all(workspaceId, serviceId, Math.min(30, Math.max(1, limit))) as Array<{ deployment_id: string; version: string; environment: string; status: string; started_at: string; completed_at: string | null; url: string | null; change_id: string; sha: string; title: string; author: string; repository: string; change_url: string | null; risk_label: string }>;
}

export function getServiceForWorkspace(workspaceId: string, serviceId: string) {
  return db.prepare("SELECT id, name FROM services WHERE workspace_id = ? AND id = ?").get(workspaceId, serviceId) as { id: string; name: string } | undefined;
}

export function listChanges(workspaceId: string) {
  return db.prepare("SELECT * FROM changes WHERE workspace_id = ? ORDER BY created_at DESC").all(workspaceId) as ChangeRow[];
}

export type ChangeQuery = { query?: string; risk?: string; service?: string; page?: number; pageSize?: number };

export function queryChanges(workspaceId: string, input: ChangeQuery = {}) {
  const pageSize = Math.min(50, Math.max(1, input.pageSize ?? 8));
  const page = Math.max(1, input.page ?? 1);
  const where = ["c.workspace_id = ?"];
  const params: Array<string | number> = [workspaceId];
  const query = input.query?.trim();
  if (query) {
    where.push("(c.sha LIKE ? OR c.title LIKE ? OR c.author LIKE ? OR c.repository LIKE ? OR s.name LIKE ?)");
    const pattern = `%${query}%`;
    params.push(pattern, pattern, pattern, pattern, pattern);
  }
  if (input.risk && input.risk !== "all") {
    where.push("c.risk_label = ?");
    params.push(input.risk);
  }
  if (input.service && input.service !== "all") {
    where.push("s.id = ?");
    params.push(input.service);
  }
  const clause = where.join(" AND ");
  const total = (db.prepare(`SELECT COUNT(DISTINCT c.id) AS count FROM changes c LEFT JOIN deployments d ON d.change_id = c.id AND d.workspace_id = c.workspace_id LEFT JOIN services s ON s.id = d.service_id AND s.workspace_id = d.workspace_id WHERE ${clause}`).get(...params) as { count: number }).count;
  const items = db.prepare(`SELECT c.*, COUNT(DISTINCT d.id) AS deployment_count, GROUP_CONCAT(DISTINCT s.name) AS affected_services FROM changes c LEFT JOIN deployments d ON d.change_id = c.id AND d.workspace_id = c.workspace_id LEFT JOIN services s ON s.id = d.service_id AND s.workspace_id = d.workspace_id WHERE ${clause} GROUP BY c.id ORDER BY c.created_at DESC LIMIT ? OFFSET ?`).all(...params, pageSize, (page - 1) * pageSize) as Array<ChangeRow & { deployment_count: number; affected_services: string | null }>;
  return { items, total, page, pageSize, pageCount: Math.max(1, Math.ceil(total / pageSize)) };
}

export type DeploymentQuery = { query?: string; environment?: string; status?: string; page?: number; pageSize?: number };

export function queryDeployments(workspaceId: string, input: DeploymentQuery = {}) {
  const pageSize = Math.min(50, Math.max(1, input.pageSize ?? 8));
  const page = Math.max(1, input.page ?? 1);
  const where = ["d.workspace_id = ?"];
  const params: Array<string | number> = [workspaceId];
  const query = input.query?.trim();
  if (query) {
    where.push("(d.version LIKE ? OR d.environment LIKE ? OR s.name LIKE ? OR c.sha LIKE ? OR c.title LIKE ?)");
    const pattern = `%${query}%`;
    params.push(pattern, pattern, pattern, pattern, pattern);
  }
  if (input.environment && input.environment !== "all") {
    where.push("d.environment = ?");
    params.push(input.environment);
  }
  if (input.status && input.status !== "all") {
    where.push("d.status = ?");
    params.push(input.status);
  }
  const clause = where.join(" AND ");
  const total = (db.prepare(`SELECT COUNT(*) AS count FROM deployments d JOIN services s ON s.id = d.service_id AND s.workspace_id = d.workspace_id JOIN changes c ON c.id = d.change_id AND c.workspace_id = d.workspace_id WHERE ${clause}`).get(...params) as { count: number }).count;
  const items = db.prepare(`SELECT d.*, s.name AS service_name, s.slug AS service_slug, c.sha, c.title AS change_title, c.author, c.repository, c.url AS change_url, c.risk_label FROM deployments d JOIN services s ON s.id = d.service_id AND s.workspace_id = d.workspace_id JOIN changes c ON c.id = d.change_id AND c.workspace_id = d.workspace_id WHERE ${clause} ORDER BY d.started_at DESC LIMIT ? OFFSET ?`).all(...params, pageSize, (page - 1) * pageSize) as Array<Record<string, string | number | null>>;
  return { items, total, page, pageSize, pageCount: Math.max(1, Math.ceil(total / pageSize)) };
}

export function getLatestWorkspaceSignal(workspaceId: string) {
  const signal = db.prepare("SELECT observed_at, source FROM signals WHERE workspace_id = ? ORDER BY observed_at DESC LIMIT 1").get(workspaceId) as { observed_at: string; source: string } | undefined;
  const telemetry = db.prepare("SELECT observed_at, signal_kind AS source FROM telemetry_references WHERE workspace_id = ? ORDER BY observed_at DESC LIMIT 1").get(workspaceId) as { observed_at: string; source: string } | undefined;
  if (!signal) return telemetry ?? null;
  if (!telemetry) return signal;
  return new Date(signal.observed_at).getTime() >= new Date(telemetry.observed_at).getTime() ? signal : telemetry;
}

export function listDeployments(workspaceId: string) {
  return db
    .prepare(
      `SELECT d.*, s.name AS service_name, c.sha, c.title AS change_title FROM deployments d JOIN services s ON s.id = d.service_id JOIN changes c ON c.id = d.change_id WHERE d.workspace_id = ? ORDER BY d.started_at DESC`,
    )
    .all(workspaceId) as Array<Record<string, string | null>>;
}

export function countRecentDeployments(workspaceId: string, hours = 24) {
  const safeHours = Math.min(168, Math.max(1, hours));
  return (db.prepare("SELECT COUNT(*) AS count FROM deployments WHERE workspace_id = ? AND datetime(started_at) >= datetime('now', ?)").get(workspaceId, `-${safeHours} hours`) as { count: number }).count;
}

export function listEvaluations(workspaceId: string) {
  return db.prepare("SELECT * FROM evaluations WHERE workspace_id = ? ORDER BY last_run_at DESC").all(workspaceId) as Array<{
    id: string;
    name: string;
    description: string;
    total_cases: number;
    pass_rate: number;
    last_run_at: string | null;
  }>;
}

export function getEvaluationCases(workspaceId: string, evaluationId: string) {
  return db.prepare("SELECT ec.* FROM evaluation_cases ec JOIN evaluations e ON e.id = ec.evaluation_id WHERE e.workspace_id = ? AND ec.evaluation_id = ? ORDER BY ec.id").all(workspaceId, evaluationId) as Array<{
    id: string;
    incident_key: string;
    expected_cause: string;
    status: string;
    confidence: number;
    expected_abstention: number;
  }>;
}

export function getLatestEvaluationRun(workspaceId: string, evaluationId: string) {
  return db.prepare("SELECT er.* FROM evaluation_runs er JOIN evaluations e ON e.id = er.evaluation_id WHERE er.workspace_id = ? AND er.evaluation_id = ? ORDER BY er.started_at DESC LIMIT 1").get(workspaceId, evaluationId) as {
    id: string;
    status: string;
    total_cases: number;
    top3_accuracy: number | null;
    evidence_coverage: number | null;
    detection_lag_ms: number | null;
    abstention_accuracy: number | null;
    details_json: string;
    started_at: string;
    completed_at: string | null;
  } | undefined;
}

export function getOverview(workspaceId: string) {
  const incidents = listIncidents(workspaceId);
  const services = listServices(workspaceId);
  const changes = listChanges(workspaceId);
  const deployments = listDeployments(workspaceId);
  return { incidents, services, changes, deployments };
}

export function getServiceMap(workspaceId: string) {
  const services = listServices(workspaceId);
  const dependencies = db.prepare(
    `SELECT sd.downstream_service_id, upstream.slug AS upstream_slug
     FROM service_dependencies sd
     JOIN services upstream ON upstream.id = sd.upstream_service_id AND upstream.workspace_id = sd.workspace_id
     WHERE sd.workspace_id = ?`,
  ).all(workspaceId) as Array<{ downstream_service_id: string; upstream_slug: string }>;
  return services.map((service, index) => ({
    ...service,
    x: [18, 50, 82][index] ?? 50,
    y: [54, 25, 62][index] ?? 50,
    dependencies: dependencies.filter((dependency) => dependency.downstream_service_id === service.id).map((dependency) => dependency.upstream_slug),
  }));
}

export function createIncident(workspaceId: string, input: { title: string; serviceId: string; severity: string; impact: string; summary: string }) {
  const id = `inc_${randomUUID().slice(0, 8)}`;
  const key = `INC-${Math.floor(1000 + Math.random() * 8999)}`;
  const time = nowIso();
  db.prepare(
    "INSERT INTO incidents (id, workspace_id, key, title, service_id, severity, status, started_at, detected_at, summary, impact) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(id, workspaceId, key, input.title, input.serviceId, input.severity, "investigating", time, time, input.summary, input.impact);
  return { id, key };
}

export function createSession(userId: string, workspaceId: string) {
  const id = randomUUID();
  const expiresAt = new Date(Date.now() + 1000 * 60 * 60 * 24 * 14).toISOString();
  db.prepare("INSERT INTO sessions (id, user_id, workspace_id, expires_at, created_at) VALUES (?, ?, ?, ?, ?)").run(id, userId, workspaceId, expiresAt, nowIso());
  return { id, expiresAt };
}

export function findSession(id: string) {
  return db
    .prepare(
      `SELECT s.id, s.user_id, s.workspace_id, s.expires_at, u.email, u.name, u.verified_at, m.role, w.name AS workspace_name, w.slug AS workspace_slug, w.mode AS workspace_mode FROM sessions s JOIN users u ON u.id = s.user_id JOIN memberships m ON m.workspace_id = s.workspace_id AND m.user_id = s.user_id JOIN workspaces w ON w.id = s.workspace_id WHERE s.id = ?`,
    )
    .get(id) as
    | {
        id: string;
        user_id: string;
        workspace_id: string;
        expires_at: string;
        email: string;
        name: string;
        verified_at: string | null;
        role: string;
        workspace_name: string;
        workspace_slug: string;
        workspace_mode: string;
      }
    | undefined;
}

export function removeSession(id: string) {
  db.prepare("DELETE FROM sessions WHERE id = ?").run(id);
}

export function revokeUserSessions(userId: string) {
  db.prepare("DELETE FROM sessions WHERE user_id = ?").run(userId);
}

export function getUserByEmail(email: string) {
  return db.prepare("SELECT * FROM users WHERE email = ?").get(email.toLowerCase().trim()) as
    | { id: string; email: string; password_hash: string; name: string; verified_at: string | null }
    | undefined;
}

export function createUser(input: { email: string; password: string; name: string }) {
  const id = `usr_${randomUUID().slice(0, 8)}`;
  const workspaceId = `ws_${randomUUID().slice(0, 8)}`;
  const timestamp = nowIso();
  const verificationToken = randomUUID().replaceAll("-", "");
  const tx = db.transaction(() => {
    db.prepare("INSERT INTO users (id, email, password_hash, name, created_at) VALUES (?, ?, ?, ?, ?)").run(
      id,
      input.email.toLowerCase().trim(),
      bcrypt.hashSync(input.password, 10),
      input.name.trim(),
      timestamp,
    );
    db.prepare("INSERT INTO workspaces (id, name, slug, mode, created_at) VALUES (?, ?, ?, ?, ?)").run(
      workspaceId,
      `${input.name.trim()}'s workspace`,
      `workspace-${id.slice(-6)}`,
      "production",
      timestamp,
    );
    db.prepare("INSERT INTO memberships (workspace_id, user_id, role, created_at) VALUES (?, ?, ?, ?)").run(workspaceId, id, "owner", timestamp);
    db.prepare("INSERT INTO email_tokens (id, user_id, type, token, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(
      randomUUID(),
      id,
      "verify",
      hashToken(verificationToken),
      new Date(Date.now() + 1000 * 60 * 60 * 24).toISOString(),
      timestamp,
    );
  });
  tx();
  return { id, workspaceId, verificationToken };
}

export function createEmailToken(userId: string, type: "verify" | "reset") {
  const token = randomUUID().replaceAll("-", "");
  db.prepare("INSERT INTO email_tokens (id, user_id, type, token, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(
    randomUUID(),
    userId,
    type,
    hashToken(token),
    new Date(Date.now() + 1000 * 60 * 60).toISOString(),
    nowIso(),
  );
  return token;
}

export function consumeEmailToken(token: string, type: "verify" | "reset") {
  return db
    .prepare("SELECT * FROM email_tokens WHERE token = ? AND type = ? AND used_at IS NULL AND expires_at > ?")
    .get(hashToken(token), type, nowIso()) as { id: string; user_id: string } | undefined;
}

export function markTokenUsed(id: string) {
  db.prepare("UPDATE email_tokens SET used_at = ? WHERE id = ?").run(nowIso(), id);
}

export function markUserVerified(userId: string) {
  db.prepare("UPDATE users SET verified_at = ? WHERE id = ?").run(nowIso(), userId);
}

export function updatePassword(userId: string, password: string) {
  db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(bcrypt.hashSync(password, 10), userId);
  revokeUserSessions(userId);
}

export function saveSignal(input: { workspaceId: string; incidentId?: string; kind: string; serviceName: string; observedAt: string; payload: unknown; source: string }) {
  const id = `sig_${randomUUID().slice(0, 8)}`;
  db.prepare("INSERT INTO signals (id, workspace_id, incident_id, kind, service_name, observed_at, payload_json, source) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(
    id,
    input.workspaceId,
    input.incidentId ?? null,
    input.kind,
    input.serviceName,
    input.observedAt,
    JSON.stringify(input.payload),
    input.source,
  );
  return id;
}
