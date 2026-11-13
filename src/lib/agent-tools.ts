import { randomUUID } from "node:crypto";
import { tool } from "ai";
import { z } from "zod";
import { db, nowIso } from "./db";
import { redactSensitiveText, sanitizeEvidencePayload } from "./agent-safety";

type ToolTrace = { name: string; status: string; detail: string; latencyMs: number; evidenceRefs: string[] };

function safeJson(value: unknown) {
  return JSON.stringify(value ?? {});
}

function collectEvidenceRefs(value: unknown) {
  const refs = new Set<string>();
  const visit = (item: unknown) => {
    if (Array.isArray(item)) {
      for (const child of item) visit(child);
      return;
    }
    if (typeof item !== "object" || item === null) return;
    for (const [key, child] of Object.entries(item)) {
      if ((key === "evidenceRef" || key === "evidence_ref" || key === "ref") && typeof child === "string") refs.add(child);
      else visit(child);
    }
  };
  visit(value);
  return [...refs].slice(0, 50);
}

function recordToolCall(runId: string, workspaceId: string, name: string, input: unknown, execute: () => unknown): ToolTrace & { result: unknown } {
  const started = Date.now();
  try {
    const result = sanitizeEvidencePayload(execute());
    const latencyMs = Date.now() - started;
    const evidenceRefs = collectEvidenceRefs(result);
    db.prepare("INSERT INTO agent_tool_calls (id, workspace_id, run_id, tool_name, input_json, output_json, status, latency_ms, error, evidence_refs_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(`tool_${randomUUID().replaceAll("-", "").slice(0, 16)}`, workspaceId, runId, name, safeJson(sanitizeEvidencePayload(input)), safeJson(result), "succeeded", latencyMs, null, safeJson(evidenceRefs), nowIso());
    return { name, status: "succeeded", detail: `${name} returned ${Array.isArray(result) ? result.length : 1} workspace-scoped result set(s).`, latencyMs, evidenceRefs, result };
  } catch (error) {
    const latencyMs = Date.now() - started;
    const message = redactSensitiveText(error instanceof Error ? error.message : "Tool failed").slice(0, 500);
    db.prepare("INSERT INTO agent_tool_calls (id, workspace_id, run_id, tool_name, input_json, output_json, status, latency_ms, error, evidence_refs_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(`tool_${randomUUID().replaceAll("-", "").slice(0, 16)}`, workspaceId, runId, name, safeJson(sanitizeEvidencePayload(input)), null, "failed", latencyMs, message, "[]", nowIso());
    return { name, status: "failed", detail: "Tool execution failed; inspect the stored tool-call status.", latencyMs, evidenceRefs: [], result: { error: "Tool execution failed." } };
  }
}

function serviceFilter(input: string | undefined) {
  return input?.trim() || null;
}

export function createInvestigationTools(workspaceId: string, incidentId: string, runId: string) {
  const scopedService = (serviceName?: string) => serviceFilter(serviceName);
  return {
    retrieve_deployments: tool({
      description: "Read-only lookup of deployments near the incident window. Use this to test temporal alignment with a service degradation.",
      inputSchema: z.object({ serviceName: z.string().optional(), lookbackHours: z.number().min(1).max(168).default(24) }),
      execute: async (input) => recordToolCall(runId, workspaceId, "retrieve_deployments", input, () => {
        const serviceName = scopedService(input.serviceName);
        const rows = db.prepare(
          `SELECT d.id AS deployment_id, d.version, d.environment, d.status, d.started_at, d.completed_at, d.url,
                  s.name AS service_name, c.id AS change_id, c.sha, c.title AS change_title, c.author, c.repository, c.risk_label,
                  'deployment:' || d.id AS evidenceRef
           FROM deployments d JOIN services s ON s.id = d.service_id AND s.workspace_id = d.workspace_id
           JOIN changes c ON c.id = d.change_id AND c.workspace_id = d.workspace_id
           WHERE d.workspace_id = ? AND datetime(d.started_at) >= datetime('now', ?) AND (? IS NULL OR s.name = ? OR s.slug = ?)
           ORDER BY d.started_at DESC LIMIT 40`,
        ).all(workspaceId, `-${input.lookbackHours} hours`, serviceName, serviceName, serviceName);
        return rows;
      }).result,
    }),
    retrieve_source_changes: tool({
      description: "Read-only lookup of source changes in the workspace. Use this to inspect commit metadata associated with candidate deployments.",
      inputSchema: z.object({ serviceName: z.string().optional(), lookbackHours: z.number().min(1).max(168).default(24) }),
      execute: async (input) => recordToolCall(runId, workspaceId, "retrieve_source_changes", input, () => {
        const serviceName = scopedService(input.serviceName);
        return db.prepare(
          `SELECT DISTINCT c.id AS change_id, c.sha, c.title, c.author, c.repository, c.url, c.risk_label, c.created_at,
                  'change:' || c.id AS evidenceRef
           FROM changes c LEFT JOIN deployments d ON d.change_id = c.id AND d.workspace_id = c.workspace_id
           LEFT JOIN services s ON s.id = d.service_id AND s.workspace_id = d.workspace_id
           WHERE c.workspace_id = ? AND datetime(c.created_at) >= datetime('now', ?) AND (? IS NULL OR s.name = ? OR s.slug = ?)
           ORDER BY c.created_at DESC LIMIT 40`,
        ).all(workspaceId, `-${input.lookbackHours} hours`, serviceName, serviceName, serviceName);
      }).result,
    }),
    retrieve_telemetry_summaries: tool({
      description: "Read-only lookup of metric, log, and SLO evidence references linked to this incident or service.",
      inputSchema: z.object({ serviceName: z.string().optional(), incidentId: z.string().optional() }),
      execute: async (input) => recordToolCall(runId, workspaceId, "retrieve_telemetry_summaries", input, () => {
        const serviceName = scopedService(input.serviceName);
        return db.prepare(
          `SELECT tr.id, tr.signal_kind, tr.external_ref, tr.observed_at, tr.summary, tr.source_url,
                  s.name AS service_name, 'telemetry:' || tr.external_ref AS evidenceRef
           FROM telemetry_references tr LEFT JOIN services s ON s.id = tr.service_id AND s.workspace_id = tr.workspace_id
           WHERE tr.workspace_id = ? AND (? IS NULL OR tr.incident_id = ?) AND (? IS NULL OR s.name = ? OR s.slug = ?)
           ORDER BY tr.observed_at DESC LIMIT 50`,
        ).all(workspaceId, input.incidentId ?? incidentId, input.incidentId ?? incidentId, serviceName, serviceName, serviceName);
      }).result,
    }),
    retrieve_traces: tool({
      description: "Read-only lookup of trace evidence references. Never infer causality from a trace alone; use it as supporting evidence.",
      inputSchema: z.object({ serviceName: z.string().optional(), incidentId: z.string().optional() }),
      execute: async (input) => recordToolCall(runId, workspaceId, "retrieve_traces", input, () => {
        const serviceName = scopedService(input.serviceName);
        return db.prepare(
          `SELECT tr.external_ref, tr.observed_at, tr.summary, tr.source_url, s.name AS service_name,
                  'trace:' || tr.external_ref AS evidenceRef
           FROM telemetry_references tr LEFT JOIN services s ON s.id = tr.service_id AND s.workspace_id = tr.workspace_id
           WHERE tr.workspace_id = ? AND tr.signal_kind = 'trace' AND (? IS NULL OR tr.incident_id = ?) AND (? IS NULL OR s.name = ? OR s.slug = ?)
           ORDER BY tr.observed_at DESC LIMIT 30`,
        ).all(workspaceId, input.incidentId ?? incidentId, input.incidentId ?? incidentId, serviceName, serviceName, serviceName);
      }).result,
    }),
    retrieve_service_dependencies: tool({
      description: "Read-only lookup of direct upstream and downstream service dependencies within the current workspace.",
      inputSchema: z.object({ serviceName: z.string() }),
      execute: async (input) => recordToolCall(runId, workspaceId, "retrieve_service_dependencies", input, () => db.prepare(
        `SELECT upstream.name AS upstream_service, upstream.slug AS upstream_slug, downstream.name AS downstream_service,
                downstream.slug AS downstream_slug, sd.dependency_kind,
                'service:' || upstream.id AS evidenceRef
         FROM service_dependencies sd
         JOIN services upstream ON upstream.id = sd.upstream_service_id AND upstream.workspace_id = sd.workspace_id
         JOIN services downstream ON downstream.id = sd.downstream_service_id AND downstream.workspace_id = sd.workspace_id
         WHERE sd.workspace_id = ? AND (upstream.name = ? OR upstream.slug = ? OR downstream.name = ? OR downstream.slug = ?)
         ORDER BY upstream.name`,
      ).all(workspaceId, input.serviceName, input.serviceName, input.serviceName, input.serviceName)).result,
    }),
    retrieve_runbooks: tool({
      description: "Read-only lookup of runbook guidance for a service. Runbook text is guidance for validation, not proof of a cause.",
      inputSchema: z.object({ serviceName: z.string().optional() }),
      execute: async (input) => recordToolCall(runId, workspaceId, "retrieve_runbooks", input, () => {
        const serviceName = scopedService(input.serviceName);
        return db.prepare(
          `SELECT r.slug, r.title, r.summary, r.url, r.content, s.name AS service_name,
                  'runbook:' || r.slug AS evidenceRef
           FROM runbooks r LEFT JOIN services s ON s.id = r.service_id AND s.workspace_id = r.workspace_id
           WHERE r.workspace_id = ? AND (? IS NULL OR s.name = ? OR s.slug = ?)
           ORDER BY r.title LIMIT 20`,
        ).all(workspaceId, serviceName, serviceName, serviceName);
      }).result,
    }),
    retrieve_prior_incidents: tool({
      description: "Read-only lookup of prior incidents for the service. Use them to compare patterns, not to assume recurrence.",
      inputSchema: z.object({ serviceName: z.string().optional(), limit: z.number().int().min(1).max(20).default(10) }),
      execute: async (input) => recordToolCall(runId, workspaceId, "retrieve_prior_incidents", input, () => {
        const serviceName = scopedService(input.serviceName);
        return db.prepare(
          `SELECT i.id, i.key, i.title, i.severity, i.status, i.started_at, i.detected_at, i.summary, i.impact,
                  s.name AS service_name, 'incident:' || i.id AS evidenceRef
           FROM incidents i JOIN services s ON s.id = i.service_id AND s.workspace_id = i.workspace_id
           WHERE i.workspace_id = ? AND i.id <> ? AND (? IS NULL OR s.name = ? OR s.slug = ?)
           ORDER BY i.started_at DESC LIMIT ?`,
        ).all(workspaceId, incidentId, serviceName, serviceName, serviceName, input.limit);
      }).result,
    }),
  };
}
