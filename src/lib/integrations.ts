import { randomUUID } from "node:crypto";
import { db, getWorkspaceById, nowIso } from "./db";

export type IntegrationStatus = "connected" | "misconfigured" | "demo_only" | "pending";

export type IntegrationView = {
  id: string;
  provider: "github" | "otel" | "runbook";
  displayName: string;
  status: IntegrationStatus;
  lastSuccessAt: string | null;
  lastErrorAt: string | null;
  lastError: string | null;
  config: Record<string, boolean | string>;
};

const definitions = [
  { provider: "github" as const, displayName: "GitHub", env: ["GITHUB_WEBHOOK_SECRET", "GITHUB_WORKSPACE_ID"] },
  { provider: "otel" as const, displayName: "OpenTelemetry", env: ["CHANGEGRAPH_INGEST_TOKEN"] },
  { provider: "runbook" as const, displayName: "Runbooks", env: [] },
];

function providerForSource(source: string) {
  if (source.toLowerCase().includes("github")) return "github" as const;
  if (source.toLowerCase().includes("otel") || source.toLowerCase().includes("telemetry")) return "otel" as const;
  return null;
}

function environmentReady(provider: (typeof definitions)[number]["provider"], workspaceId: string) {
  if (provider === "github") return Boolean(process.env.GITHUB_WEBHOOK_SECRET && process.env.GITHUB_WORKSPACE_ID === workspaceId);
  if (provider === "otel") return Boolean(process.env.CHANGEGRAPH_INGEST_TOKEN && process.env.CHANGEGRAPH_INGEST_WORKSPACE_ID === workspaceId);
  return false;
}

function configSummary(provider: (typeof definitions)[number]["provider"]) {
  if (provider === "github") return { webhookSecretConfigured: Boolean(process.env.GITHUB_WEBHOOK_SECRET), workspaceConfigured: Boolean(process.env.GITHUB_WORKSPACE_ID) };
  if (provider === "otel") return { ingestTokenConfigured: Boolean(process.env.CHANGEGRAPH_INGEST_TOKEN), workspaceConfigured: Boolean(process.env.CHANGEGRAPH_INGEST_WORKSPACE_ID) };
  return { externalFetcherConfigured: false };
}

export function ensureIntegrations(workspaceId: string) {
  const timestamp = nowIso();
  for (const definition of definitions) {
    const exists = db.prepare("SELECT id FROM integrations WHERE workspace_id = ? AND provider = ?").get(workspaceId, definition.provider);
    if (!exists) {
      db.prepare(
        "INSERT INTO integrations (id, workspace_id, provider, status, display_name, config_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(`int_${randomUUID().replaceAll("-", "").slice(0, 16)}`, workspaceId, definition.provider, "misconfigured", definition.displayName, JSON.stringify(configSummary(definition.provider)), timestamp, timestamp);
    }
  }
}

export function markIntegrationStatus(workspaceId: string, source: string, status: "connected" | "misconfigured" | "pending", error?: string) {
  const provider = providerForSource(source);
  if (!provider || !getWorkspaceById(workspaceId)) return;
  ensureIntegrations(workspaceId);
  const workspace = getWorkspaceById(workspaceId);
  if (workspace?.mode === "demo") {
    db.prepare("UPDATE integrations SET status = 'demo_only', updated_at = ?, last_error = NULL WHERE workspace_id = ? AND provider = ?").run(nowIso(), workspaceId, provider);
    return;
  }
  const timestamp = nowIso();
  db.prepare(
    "UPDATE integrations SET status = ?, config_json = ?, last_success_at = CASE WHEN ? = 'connected' THEN ? ELSE last_success_at END, last_error_at = CASE WHEN ? = 'misconfigured' THEN ? ELSE last_error_at END, last_error = CASE WHEN ? = 'misconfigured' THEN ? ELSE NULL END, updated_at = ? WHERE workspace_id = ? AND provider = ?",
  ).run(status, JSON.stringify(configSummary(provider)), status, timestamp, status, timestamp, status, error ?? null, timestamp, workspaceId, provider);
}

export function getIntegrationStatuses(workspaceId: string): IntegrationView[] {
  ensureIntegrations(workspaceId);
  const workspace = getWorkspaceById(workspaceId);
  const rows = db.prepare("SELECT * FROM integrations WHERE workspace_id = ? ORDER BY provider").all(workspaceId) as Array<{
    id: string;
    provider: "github" | "otel" | "runbook";
    display_name: string;
    status: IntegrationStatus;
    config_json: string;
    last_success_at: string | null;
    last_error_at: string | null;
    last_error: string | null;
  }>;
  return rows.map((row) => {
    if (workspace?.mode === "demo") {
      return { id: row.id, provider: row.provider, displayName: row.display_name, status: "demo_only", lastSuccessAt: row.last_success_at, lastErrorAt: row.last_error_at, lastError: row.last_error, config: JSON.parse(row.config_json) as Record<string, boolean | string> };
    }
    const ready = environmentReady(row.provider, workspaceId);
    const status: IntegrationStatus = row.status === "connected" && ready ? "connected" : ready ? "pending" : "misconfigured";
    return { id: row.id, provider: row.provider, displayName: row.display_name, status, lastSuccessAt: row.last_success_at, lastErrorAt: row.last_error_at, lastError: row.last_error, config: JSON.parse(row.config_json) as Record<string, boolean | string> };
  });
}
