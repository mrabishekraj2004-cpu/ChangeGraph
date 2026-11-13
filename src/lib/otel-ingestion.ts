import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import { ingestEvent, processEvent } from "./event-processing";
import { getWorkspaceById, seedIfNeeded } from "./db";
import { markIntegrationStatus } from "./integrations";
import { mutationGuard } from "./security";

type SignalKind = "traces" | "metrics" | "logs";

function valueFromAttributes(attributes: unknown, key: string) {
  if (!Array.isArray(attributes)) return undefined;
  const entry = attributes.find((item) => typeof item === "object" && item !== null && "key" in item && item.key === key) as { value?: { stringValue?: string } } | undefined;
  return entry?.value?.stringValue;
}

function findServiceName(item: Record<string, unknown>, body: Record<string, unknown>) {
  const resource = item.resource as { attributes?: unknown } | undefined;
  return (typeof item.serviceName === "string" && item.serviceName) || valueFromAttributes(resource?.attributes, "service.name") || (typeof body.serviceName === "string" && body.serviceName) || "unknown-service";
}

function stableRef(kind: SignalKind, item: unknown, index: number, requestId: string | null) {
  const digest = createHash("sha256").update(JSON.stringify(item)).digest("hex").slice(0, 24);
  return requestId || `${kind}:${digest}:${index}`;
}

export async function handleOtelIngestion(request: Request, kind: SignalKind) {
  const blocked = mutationGuard(request, `otel:${kind}`, { limit: 600, windowMs: 60_000 });
  if (blocked) return blocked;
  seedIfNeeded();
  const expected = process.env.CHANGEGRAPH_INGEST_TOKEN;
  const supplied = request.headers.get("x-changegraph-ingest-token");
  const configuredWorkspaceId = process.env.CHANGEGRAPH_INGEST_WORKSPACE_ID;
  if (!expected || !configuredWorkspaceId) return NextResponse.json({ error: "CHANGEGRAPH_INGEST_TOKEN and CHANGEGRAPH_INGEST_WORKSPACE_ID must be configured." }, { status: 503 });
  if (!supplied || supplied !== expected) return NextResponse.json({ error: "Invalid ingestion token." }, { status: 401 });
  let body: Record<string, unknown>;
  try {
    body = await request.json() as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Request body must be valid JSON." }, { status: 400 });
  }
  const workspaceId = request.headers.get("x-changegraph-workspace-id") || (typeof body.workspaceId === "string" ? body.workspaceId : "");
  if (!workspaceId) return NextResponse.json({ error: "x-changegraph-workspace-id or workspaceId is required." }, { status: 400 });
  if (workspaceId !== configuredWorkspaceId) return NextResponse.json({ error: "Telemetry workspace does not match the configured ingestion workspace." }, { status: 403 });
  const workspace = getWorkspaceById(workspaceId);
  if (!workspace) return NextResponse.json({ error: "Workspace not found." }, { status: 404 });
  const field = kind === "traces" ? "resourceSpans" : kind === "metrics" ? "resourceMetrics" : "resourceLogs";
  const items = Array.isArray(body[field]) ? body[field] : [body];
  const requestId = request.headers.get("x-request-id");
  const results = [];
  for (const [index, item] of items.entries()) {
    const normalized = (typeof item === "object" && item !== null ? item : {}) as Record<string, unknown>;
    const externalRef = stableRef(kind, item, index, items.length === 1 ? requestId : null);
    const event = {
      schemaVersion: 1 as const,
      eventId: `evt_${createHash("sha256").update(`${workspaceId}:${kind}:${externalRef}`).digest("hex").slice(0, 20)}`,
      eventType: "telemetry.reference.v1" as const,
      source: "otel-http",
      externalId: externalRef,
      idempotencyKey: `${workspaceId}:${kind}:${externalRef}`,
      workspaceId,
      occurredAt: new Date().toISOString(),
      payload: {
        signalKind: kind === "traces" ? "trace" as const : kind === "metrics" ? "metric" as const : "log" as const,
        serviceName: findServiceName(normalized, body),
        externalRef,
        observedAt: typeof body.observedAt === "string" ? body.observedAt : new Date().toISOString(),
        summary: typeof body.summary === "string" ? body.summary : `OpenTelemetry ${kind} reference received for ${findServiceName(normalized, body)}.`,
        sourceUrl: typeof body.sourceUrl === "string" ? body.sourceUrl : undefined,
        incidentId: typeof body.incidentId === "string" ? body.incidentId : undefined,
        payload: item,
      },
    };
    try {
      const accepted = ingestEvent(event);
      const processed = processEvent(accepted.eventId);
      results.push({ ...accepted, processed });
    } catch (error) {
      markIntegrationStatus(workspaceId, "otel-http", "misconfigured", error instanceof Error ? error.message : "OTel event failed");
      return NextResponse.json({ error: error instanceof Error ? error.message : "Telemetry event failed.", accepted: results }, { status: 422 });
    }
  }
  if (results.length > 0 && results.every((result) => result.processed.status === "processed")) {
    markIntegrationStatus(workspaceId, "otel-http", "connected");
  } else if (results.length === 0) {
    markIntegrationStatus(workspaceId, "otel-http", "pending");
  } else if (results.some((result) => result.processed.status === "dead_letter")) {
    const failed = results.find((result) => result.processed.status === "dead_letter");
    const error = failed && "error" in failed.processed && typeof failed.processed.error === "string" ? failed.processed.error : "Telemetry event moved to the dead-letter queue.";
    markIntegrationStatus(workspaceId, "otel-http", "misconfigured", error);
  } else {
    markIntegrationStatus(workspaceId, "otel-http", "pending");
  }
  return NextResponse.json({ accepted: true, workspaceId, signalKind: kind, events: results }, { status: 202 });
}
