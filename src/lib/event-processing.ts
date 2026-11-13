import { randomUUID } from "node:crypto";
import { db, getWorkspaceById, nowIso, saveSignal } from "./db";
import { eventTimestamp, parseChangeGraphEvent, type ChangeGraphEvent } from "./events";
import { markIntegrationStatus } from "./integrations";

type EventRow = {
  id: string;
  workspace_id: string | null;
  source: string;
  event_type: string;
  schema_version: number;
  external_id: string;
  idempotency_key: string;
  payload_json: string;
  headers_json: string;
  status: string;
  attempt_count: number;
  next_attempt_at: string | null;
  received_at: string;
  processed_at: string | null;
  last_error: string | null;
  processing_started_at: string | null;
  processing_worker_id: string | null;
};

type IngestResult = {
  accepted: boolean;
  duplicate: boolean;
  eventId: string;
  status: string;
};

function maxAttempts() {
  const configured = Number(process.env.CHANGEGRAPH_MAX_EVENT_ATTEMPTS || 3);
  return Number.isFinite(configured) && configured >= 1 ? Math.min(10, Math.floor(configured)) : 3;
}

function leaseDurationMs() {
  const configured = Number(process.env.CHANGEGRAPH_EVENT_LEASE_SECONDS || 300);
  return Number.isFinite(configured) && configured >= 30 ? Math.min(3600, Math.floor(configured)) * 1000 : 300_000;
}

function leaseCutoff() {
  return new Date(Date.now() - leaseDurationMs()).toISOString();
}

function makeId(prefix: string) {
  return `${prefix}_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
}

function safeJson(value: unknown) {
  return JSON.stringify(value ?? {});
}

function normalizeSlug(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 80) || "unknown-service";
}

function addAuditEvent(workspaceId: string, action: string, entityType: string, entityId: string | null, metadata: unknown) {
  db.prepare(
    "INSERT INTO audit_events (id, workspace_id, actor_user_id, action, entity_type, entity_id, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(makeId("audit"), workspaceId, null, action, entityType, entityId, safeJson(metadata), nowIso());
}

function ensureService(workspaceId: string, slug: string, name: string, owner = "Unknown", status = "unknown", healthScore = 0) {
  const normalized = normalizeSlug(slug);
  db.prepare(
    `INSERT INTO services (id, workspace_id, name, slug, owner, status, health_score, last_deploy_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, NULL)
     ON CONFLICT (workspace_id, slug) DO UPDATE SET name = excluded.name`,
  ).run(makeId("svc"), workspaceId, name, normalized, owner, status, healthScore);
  return db.prepare("SELECT id, name, slug FROM services WHERE workspace_id = ? AND slug = ?").get(workspaceId, normalized) as { id: string; name: string; slug: string };
}

function ensureChange(workspaceId: string, input: { sha: string; title: string; author: string; repository: string; url?: string; riskLabel?: string; createdAt?: string }, provider: string, externalId: string) {
  const existing = db.prepare("SELECT id FROM changes WHERE workspace_id = ? AND ((provider = ? AND external_id = ?) OR sha = ?) LIMIT 1").get(workspaceId, provider, externalId, input.sha) as { id: string } | undefined;
  const createdAt = eventTimestamp(input.createdAt ?? nowIso());
  if (existing) {
    db.prepare(
      "UPDATE changes SET sha = ?, title = ?, author = ?, repository = ?, url = ?, risk_label = ?, created_at = ?, provider = ?, external_id = ? WHERE workspace_id = ? AND id = ?",
    ).run(input.sha, input.title, input.author, input.repository, input.url ?? null, input.riskLabel ?? "unknown", createdAt, provider, externalId, workspaceId, existing.id);
    return existing.id;
  }
  const id = makeId("chg");
  db.prepare(
    "INSERT INTO changes (id, workspace_id, sha, title, author, repository, url, risk_label, created_at, provider, external_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(id, workspaceId, input.sha, input.title, input.author, input.repository, input.url ?? null, input.riskLabel ?? "unknown", createdAt, provider, externalId);
  return id;
}

function findOrCreateChange(workspaceId: string, event: Extract<ChangeGraphEvent, { eventType: "deployment.v1" }>, provider: string) {
  const payload = event.payload;
  const sha = payload.changeSha || `deployment:${event.externalId}`;
  return ensureChange(workspaceId, {
    sha,
    title: payload.changeTitle || `Deployment ${payload.version}`,
    author: payload.author || "Unknown",
    repository: payload.repository || "unknown/repository",
    url: payload.url,
    createdAt: payload.startedAt,
  }, provider, payload.changeSha || event.externalId);
}

function appendDeploymentEvidence(workspaceId: string, serviceId: string, deploymentId: string, payload: Extract<ChangeGraphEvent, { eventType: "deployment.v1" }>['payload']) {
  const incidents = db.prepare(
    "SELECT id FROM incidents WHERE workspace_id = ? AND service_id = ? AND status NOT IN ('resolved', 'closed')",
  ).all(workspaceId, serviceId) as Array<{ id: string }>;
  const title = `Deployment ${payload.version} ${payload.status}`;
  for (const incident of incidents) {
    db.prepare(
      "INSERT INTO timeline_events (id, incident_id, occurred_at, type, title, description, source_url, evidence_kind, evidence_ref) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(makeId("evt"), incident.id, eventTimestamp(payload.startedAt), "change", title, `${payload.serviceSlug} deployment reported ${payload.status}.`, payload.url ?? null, "deployment", deploymentId);
  }
}

function handleChange(workspaceId: string, event: Extract<ChangeGraphEvent, { eventType: "source.change.v1" }>) {
  const changeId = ensureChange(workspaceId, event.payload, event.source, event.externalId);
  addAuditEvent(workspaceId, "event.change.upserted", "change", changeId, { externalId: event.externalId, source: event.source });
}

function handleDeployment(workspaceId: string, event: Extract<ChangeGraphEvent, { eventType: "deployment.v1" }>) {
  const service = ensureService(workspaceId, event.payload.serviceSlug, event.payload.serviceName || event.payload.serviceSlug, "Unknown");
  const changeId = findOrCreateChange(workspaceId, event, event.source);
  const existing = db.prepare("SELECT id FROM deployments WHERE workspace_id = ? AND provider = ? AND external_id = ?").get(workspaceId, event.source, event.externalId) as { id: string } | undefined;
  const deploymentId = existing?.id || makeId("dep");
  if (existing) {
    db.prepare(
      "UPDATE deployments SET service_id = ?, change_id = ?, version = ?, environment = ?, status = ?, started_at = ?, completed_at = ?, url = ? WHERE workspace_id = ? AND id = ?",
    ).run(service.id, changeId, event.payload.version, event.payload.environment, event.payload.status, eventTimestamp(event.payload.startedAt), event.payload.completedAt ? eventTimestamp(event.payload.completedAt) : null, event.payload.url ?? null, workspaceId, deploymentId);
  } else {
    db.prepare(
      "INSERT INTO deployments (id, workspace_id, service_id, change_id, version, environment, status, started_at, completed_at, url, provider, external_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(deploymentId, workspaceId, service.id, changeId, event.payload.version, event.payload.environment, event.payload.status, eventTimestamp(event.payload.startedAt), event.payload.completedAt ? eventTimestamp(event.payload.completedAt) : null, event.payload.url ?? null, event.source, event.externalId);
  }
  db.prepare("UPDATE services SET last_deploy_at = ? WHERE workspace_id = ? AND id = ?").run(eventTimestamp(event.payload.startedAt), workspaceId, service.id);
  appendDeploymentEvidence(workspaceId, service.id, deploymentId, event.payload);
  addAuditEvent(workspaceId, "event.deployment.upserted", "deployment", deploymentId, { externalId: event.externalId, source: event.source });
}

function handleServiceMetadata(workspaceId: string, event: Extract<ChangeGraphEvent, { eventType: "service.metadata.v1" }>) {
  const service = ensureService(workspaceId, event.payload.slug, event.payload.name, event.payload.owner, event.payload.status || "unknown", event.payload.healthScore ?? 0);
  db.prepare("UPDATE services SET owner = ?, status = ?, health_score = ? WHERE workspace_id = ? AND id = ?").run(event.payload.owner, event.payload.status || "unknown", event.payload.healthScore ?? 0, workspaceId, service.id);
  if (event.payload.dependencies) {
    db.prepare("DELETE FROM service_dependencies WHERE workspace_id = ? AND downstream_service_id = ?").run(workspaceId, service.id);
    for (const dependency of event.payload.dependencies) {
      const upstream = ensureService(workspaceId, dependency, dependency);
      if (upstream.id === service.id) continue;
      db.prepare(
        "INSERT OR IGNORE INTO service_dependencies (workspace_id, upstream_service_id, downstream_service_id, dependency_kind, created_at) VALUES (?, ?, ?, ?, ?)",
      ).run(workspaceId, upstream.id, service.id, "runtime", nowIso());
    }
  }
  addAuditEvent(workspaceId, "event.service_metadata.upserted", "service", service.id, { externalId: event.externalId, source: event.source });
}

function handleTelemetryReference(workspaceId: string, event: Extract<ChangeGraphEvent, { eventType: "telemetry.reference.v1" }>) {
  const serviceSlug = normalizeSlug(event.payload.serviceName);
  const service = db.prepare("SELECT id FROM services WHERE workspace_id = ? AND (name = ? OR slug = ?) LIMIT 1").get(workspaceId, event.payload.serviceName, serviceSlug) as { id: string } | undefined;
  const incident = event.payload.incidentId
    ? db.prepare("SELECT id FROM incidents WHERE workspace_id = ? AND id = ?").get(workspaceId, event.payload.incidentId) as { id: string } | undefined
    : undefined;
  if (event.payload.incidentId && !incident) throw new Error("Telemetry incident does not belong to the event workspace.");
  const referenceId = makeId("tel");
  const result = db.prepare(
    `INSERT OR IGNORE INTO telemetry_references
      (id, workspace_id, incident_id, service_id, signal_kind, external_ref, observed_at, summary, source_url, payload_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(referenceId, workspaceId, incident?.id ?? null, service?.id ?? null, event.payload.signalKind, event.payload.externalRef, eventTimestamp(event.payload.observedAt), event.payload.summary, event.payload.sourceUrl ?? null, safeJson(event.payload.payload ?? {}), nowIso());
  if (result.changes > 0) {
    saveSignal({ workspaceId, incidentId: incident?.id, kind: event.payload.signalKind, serviceName: event.payload.serviceName, observedAt: eventTimestamp(event.payload.observedAt), payload: event.payload.payload ?? {}, source: event.source });
    if (incident) {
      db.prepare(
        "INSERT INTO timeline_events (id, incident_id, occurred_at, type, title, description, source_url, evidence_kind, evidence_ref) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(makeId("evt"), incident.id, eventTimestamp(event.payload.observedAt), event.payload.signalKind, `${event.payload.signalKind} reference received`, event.payload.summary, event.payload.sourceUrl ?? null, event.payload.signalKind, event.payload.externalRef);
    }
  }
  addAuditEvent(workspaceId, "event.telemetry_reference.recorded", "telemetry_reference", referenceId, { externalId: event.externalId, source: event.source, inserted: result.changes > 0 });
}

function handleEvent(event: ChangeGraphEvent) {
  if (!getWorkspaceById(event.workspaceId)) throw new Error("Event workspace does not exist.");
  const tx = db.transaction(() => {
    switch (event.eventType) {
      case "source.change.v1":
        handleChange(event.workspaceId, event);
        break;
      case "deployment.v1":
        handleDeployment(event.workspaceId, event);
        break;
      case "service.metadata.v1":
        handleServiceMetadata(event.workspaceId, event);
        break;
      case "telemetry.reference.v1":
        handleTelemetryReference(event.workspaceId, event);
        break;
    }
  });
  tx();
}

export function ingestEvent(event: ChangeGraphEvent, headers: Record<string, string | null> = {}): IngestResult {
  if (!getWorkspaceById(event.workspaceId)) throw new Error("Event workspace does not exist.");
  const existing = db.prepare("SELECT id, status FROM event_inbox WHERE source = ? AND idempotency_key = ?").get(event.source, event.idempotencyKey) as { id: string; status: string } | undefined;
  if (existing) return { accepted: false, duplicate: true, eventId: existing.id, status: existing.status };
  const id = event.eventId;
  try {
    db.prepare(
      "INSERT INTO event_inbox (id, workspace_id, source, event_type, schema_version, external_id, idempotency_key, payload_json, headers_json, status, received_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(id, event.workspaceId, event.source, event.eventType, event.schemaVersion, event.externalId, event.idempotencyKey, safeJson(event), safeJson(headers), "received", nowIso());
  } catch (error) {
    const duplicate = db.prepare("SELECT id, status FROM event_inbox WHERE source = ? AND idempotency_key = ?").get(event.source, event.idempotencyKey) as { id: string; status: string } | undefined;
    if (duplicate) return { accepted: false, duplicate: true, eventId: duplicate.id, status: duplicate.status };
    throw error;
  }
  return { accepted: true, duplicate: false, eventId: id, status: "received" };
}

export function processEvent(eventId: string) {
  const workerId = makeId("worker");
  const claim = db.transaction(() => {
    const event = db.prepare("SELECT * FROM event_inbox WHERE id = ?").get(eventId) as EventRow | undefined;
    if (!event) return { kind: "finished" as const, result: { eventId, status: "missing", attempt: 0 } };
    if (event.status === "processed" || event.status === "dead_letter") return { kind: "finished" as const, result: { eventId, status: event.status, attempt: event.attempt_count } };
    if (event.next_attempt_at && event.next_attempt_at > nowIso()) return { kind: "finished" as const, result: { eventId, status: event.status, attempt: event.attempt_count } };

    const cutoff = leaseCutoff();
    const staleProcessing = event.status === "processing" && (!event.processing_started_at || event.processing_started_at <= cutoff);
    if (event.status === "processing" && !staleProcessing) return { kind: "finished" as const, result: { eventId, status: "busy", attempt: event.attempt_count } };

    const attempt = event.attempt_count + 1;
    const startedAt = nowIso();
    const updated = db.prepare(
      `UPDATE event_inbox
       SET status = 'processing', attempt_count = ?, last_error = NULL, processing_started_at = ?, processing_worker_id = ?
       WHERE id = ? AND (status IN ('received', 'retrying') OR (status = 'processing' AND (processing_started_at IS NULL OR processing_started_at <= ?)))`,
    ).run(attempt, startedAt, workerId, eventId, cutoff);
    if (updated.changes !== 1) return { kind: "finished" as const, result: { eventId, status: "busy", attempt: event.attempt_count } };
    const attemptId = makeId("attempt");
    db.prepare("INSERT INTO event_attempts (id, event_id, attempt, status, started_at) VALUES (?, ?, ?, ?, ?)").run(attemptId, eventId, attempt, "processing", startedAt);
    return { kind: "claimed" as const, event, attempt, attemptId };
  })();

  if (claim.kind === "finished") return claim.result;
  const { event, attempt, attemptId } = claim;

  try {
    const parsed = parseChangeGraphEvent(JSON.parse(event.payload_json));
    if (!parsed.success) throw new Error(`Invalid ChangeGraph event: ${parsed.error.issues.map((issue) => issue.path.join(".") || "event").join(", ")}`);
    handleEvent(parsed.data);
    const finishedAt = nowIso();
    db.prepare("UPDATE event_attempts SET status = 'succeeded', finished_at = ? WHERE id = ?").run(finishedAt, attemptId);
    db.prepare("UPDATE event_inbox SET status = 'processed', processed_at = ?, next_attempt_at = NULL, processing_started_at = NULL, processing_worker_id = NULL WHERE id = ? AND processing_worker_id = ?").run(finishedAt, eventId, workerId);
    markIntegrationStatus(parsed.data.workspaceId, parsed.data.source, "connected");
    return { eventId, status: "processed", attempt };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown event processing failure";
    const finishedAt = nowIso();
    db.prepare("UPDATE event_attempts SET status = 'failed', error = ?, finished_at = ? WHERE id = ?").run(message, finishedAt, attemptId);
    if (attempt >= maxAttempts()) {
      db.prepare("INSERT OR IGNORE INTO dead_letter_events (id, event_id, workspace_id, reason, payload_json, attempts, failed_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(makeId("dlq"), eventId, event.workspace_id, message, event.payload_json, attempt, finishedAt);
      db.prepare("UPDATE event_inbox SET status = 'dead_letter', last_error = ?, next_attempt_at = NULL, processing_started_at = NULL, processing_worker_id = NULL WHERE id = ? AND processing_worker_id = ?").run(message, eventId, workerId);
      if (event.workspace_id) markIntegrationStatus(event.workspace_id, event.source, "misconfigured", message);
      return { eventId, status: "dead_letter", attempt, error: message };
    }
    const retryAt = new Date(Date.now() + 2 ** (attempt - 1) * 1_000).toISOString();
    db.prepare("UPDATE event_inbox SET status = 'retrying', last_error = ?, next_attempt_at = ?, processing_started_at = NULL, processing_worker_id = NULL WHERE id = ? AND processing_worker_id = ?").run(message, retryAt, eventId, workerId);
    if (event.workspace_id) markIntegrationStatus(event.workspace_id, event.source, "misconfigured", message);
    return { eventId, status: "retrying", attempt, retryAt, error: message };
  }
}

export function processPendingEvents(limit = 25, workspaceId?: string) {
  const boundedLimit = Math.max(1, Math.min(limit, 100));
  const cutoff = leaseCutoff();
  const events = workspaceId
    ? db.prepare(
        "SELECT id FROM event_inbox WHERE workspace_id = ? AND ((status IN ('received', 'retrying') AND (next_attempt_at IS NULL OR next_attempt_at <= ?)) OR (status = 'processing' AND (processing_started_at IS NULL OR processing_started_at <= ?))) ORDER BY received_at ASC LIMIT ?",
      ).all(workspaceId, nowIso(), cutoff, boundedLimit)
    : db.prepare(
        "SELECT id FROM event_inbox WHERE ((status IN ('received', 'retrying') AND (next_attempt_at IS NULL OR next_attempt_at <= ?)) OR (status = 'processing' AND (processing_started_at IS NULL OR processing_started_at <= ?))) ORDER BY received_at ASC LIMIT ?",
      ).all(nowIso(), cutoff, boundedLimit);
  const typedEvents = events as Array<{ id: string }>;
  return typedEvents.map((event) => processEvent(event.id));
}

export function replayDeadLetter(workspaceId: string, deadLetterId: string) {
  const row = db.prepare(
    `SELECT dlq.id, dlq.event_id
     FROM dead_letter_events dlq
     JOIN event_inbox inbox ON inbox.id = dlq.event_id AND inbox.workspace_id = dlq.workspace_id
     WHERE dlq.workspace_id = ? AND dlq.id = ?`,
  ).get(workspaceId, deadLetterId) as { id: string; event_id: string } | undefined;
  if (!row) return null;
  const tx = db.transaction(() => {
    db.prepare("UPDATE event_inbox SET status = 'received', attempt_count = 0, next_attempt_at = NULL, processed_at = NULL, last_error = NULL, processing_started_at = NULL, processing_worker_id = NULL WHERE id = ? AND workspace_id = ?").run(row.event_id, workspaceId);
    db.prepare("DELETE FROM dead_letter_events WHERE id = ? AND workspace_id = ?").run(deadLetterId, workspaceId);
  });
  tx();
  return { eventId: row.event_id };
}
