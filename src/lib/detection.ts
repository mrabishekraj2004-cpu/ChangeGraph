import { randomUUID } from "node:crypto";
import { db, nowIso } from "./db";

type SignalRow = {
  id: string;
  workspace_id: string;
  incident_id: string | null;
  kind: string;
  service_name: string;
  observed_at: string;
  payload_json: string;
  source: string;
};

type ServiceRow = { id: string; name: string; slug: string; owner: string; health_score: number };

export type HealthBaseline = {
  id: string;
  workspaceId: string;
  serviceId: string;
  serviceName: string;
  metricName: string;
  metricKind: string;
  baselineValue: number;
  sampleCount: number;
  windowStart: string;
  windowEnd: string;
  computedAt: string;
};

export type HealthAnomaly = {
  id: string;
  workspaceId: string;
  serviceId: string;
  serviceName: string;
  incidentId: string | null;
  signalId: string;
  metricName: string;
  metricKind: string;
  observedValue: number;
  baselineValue: number;
  deltaRatio: number;
  threshold: number;
  severity: string;
  explanation: string;
  observedAt: string;
  evidenceRef: string;
};

export type HypothesisFactor = {
  name: string;
  value: number;
  explanation: string;
  evidenceRefs: string[];
};

export type RankedHypothesis = {
  id: string;
  incidentId: string;
  rank: number;
  title: string;
  summary: string;
  status: "uncertain" | "abstain";
  confidence: number;
  isAbstention: boolean;
  factors: HypothesisFactor[];
  evidenceRefs: string[];
  abstentionReason?: string;
};

type Measurement = {
  metricName: string;
  metricKind: "error_rate" | "latency_ms" | "slo_availability" | "slo_burn_rate";
  value: number;
  unit?: string;
};

function makeId(prefix: string) {
  return `${prefix}_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
}

function parsePayload(input: string) {
  try {
    const parsed = JSON.parse(input) as unknown;
    return typeof parsed === "object" && parsed !== null ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function numberValue(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value : undefined;
}

function measurementForSignal(signal: SignalRow): Measurement | null {
  const payload = parsePayload(signal.payload_json);
  const metricName = stringValue(payload.metric) || stringValue(payload.metricName) || stringValue(payload.name) || "";
  const explicitErrorRate = numberValue(payload.errorRate) ?? numberValue(payload.error_rate);
  const explicitLatency = numberValue(payload.latencyMs) ?? numberValue(payload.latency_ms);
  const explicitAvailability = numberValue(payload.sloAvailability) ?? numberValue(payload.availability);
  const explicitBurnRate = numberValue(payload.sloBurnRate) ?? numberValue(payload.burnRate) ?? numberValue(payload.burn_rate);
  const value = numberValue(payload.value) ?? numberValue(payload.asDouble) ?? numberValue(payload.asInt);
  const lowerName = metricName.toLowerCase();
  if (explicitErrorRate !== undefined || /error|failure|5xx|4xx/.test(lowerName)) {
    const measured = explicitErrorRate ?? value;
    return measured === undefined ? null : { metricName: metricName || "error_rate", metricKind: "error_rate", value: measured, unit: "ratio" };
  }
  if (explicitLatency !== undefined || /latency|duration|p95|p99/.test(lowerName)) {
    const measured = explicitLatency ?? value;
    return measured === undefined ? null : { metricName: metricName || "latency_ms", metricKind: "latency_ms", value: measured, unit: stringValue(payload.unit) || "ms" };
  }
  if (explicitBurnRate !== undefined || /burn.?rate/.test(lowerName)) {
    const measured = explicitBurnRate ?? value;
    return measured === undefined ? null : { metricName: metricName || "slo_burn_rate", metricKind: "slo_burn_rate", value: measured, unit: "ratio" };
  }
  if (explicitAvailability !== undefined || /availability|slo/.test(lowerName)) {
    const measured = explicitAvailability ?? value;
    return measured === undefined ? null : { metricName: metricName || "slo_availability", metricKind: "slo_availability", value: measured, unit: "ratio" };
  }
  return null;
}

function listSignals(workspaceId: string) {
  return db.prepare("SELECT * FROM signals WHERE workspace_id = ? ORDER BY observed_at ASC").all(workspaceId) as SignalRow[];
}

function listServices(workspaceId: string) {
  return db.prepare("SELECT id, name, slug, owner, health_score FROM services WHERE workspace_id = ? ORDER BY name").all(workspaceId) as ServiceRow[];
}

function findService(services: ServiceRow[], name: string) {
  const normalized = name.toLowerCase();
  return services.find((service) => service.name.toLowerCase() === normalized || service.slug.toLowerCase() === normalized);
}

export function establishHealthBaselines(workspaceId: string): HealthBaseline[] {
  const services = listServices(workspaceId);
  const signals = listSignals(workspaceId);
  const cutoff = Date.now() - 10 * 60_000;
  const grouped = new Map<string, { service: ServiceRow; measurement: Measurement; signals: SignalRow[] }>();
  for (const signal of signals) {
    const service = findService(services, signal.service_name);
    const measurement = measurementForSignal(signal);
    if (!service || !measurement || signal.incident_id || new Date(signal.observed_at).getTime() > cutoff) continue;
    const key = `${service.id}:${measurement.metricName}`;
    const current = grouped.get(key);
    if (current) current.signals.push(signal);
    else grouped.set(key, { service, measurement, signals: [signal] });
  }
  const computedAt = nowIso();
  const save = db.prepare(
    `INSERT INTO service_health_baselines
      (id, workspace_id, service_id, metric_name, metric_kind, baseline_value, baseline_unit, sample_count, window_start, window_end, source, computed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (workspace_id, service_id, metric_name) DO UPDATE SET
       metric_kind = excluded.metric_kind, baseline_value = excluded.baseline_value, baseline_unit = excluded.baseline_unit,
       sample_count = excluded.sample_count, window_start = excluded.window_start, window_end = excluded.window_end,
       source = excluded.source, computed_at = excluded.computed_at`,
  );
  for (const item of grouped.values()) {
    const values = item.signals.map((signal) => measurementForSignal(signal)?.value).filter((value): value is number => value !== undefined);
    if (!values.length) continue;
    const baseline = values.reduce((sum, value) => sum + value, 0) / values.length;
    const timestamps = item.signals.map((signal) => signal.observed_at).sort();
    save.run(makeId("base"), workspaceId, item.service.id, item.measurement.metricName, item.measurement.metricKind, baseline, item.measurement.unit ?? null, values.length, timestamps[0], timestamps.at(-1), "signals", computedAt);
  }
  const rows = db.prepare(
    `SELECT b.*, s.name AS service_name FROM service_health_baselines b
     JOIN services s ON s.id = b.service_id AND s.workspace_id = b.workspace_id
     WHERE b.workspace_id = ? ORDER BY s.name, b.metric_name`,
  ).all(workspaceId) as Array<{ id: string; workspace_id: string; service_id: string; service_name: string; metric_name: string; metric_kind: string; baseline_value: number; sample_count: number; window_start: string; window_end: string; computed_at: string }>;
  return rows.map((row) => ({ id: row.id, workspaceId: row.workspace_id, serviceId: row.service_id, serviceName: row.service_name, metricName: row.metric_name, metricKind: row.metric_kind, baselineValue: row.baseline_value, sampleCount: row.sample_count, windowStart: row.window_start, windowEnd: row.window_end, computedAt: row.computed_at }));
}

function anomalyDelta(measurement: Measurement, baseline: number) {
  if (measurement.metricKind === "slo_availability") return (baseline - measurement.value) / Math.max(Math.abs(baseline), 0.0001);
  return (measurement.value - baseline) / Math.max(Math.abs(baseline), measurement.metricKind === "error_rate" ? 0.001 : 0.0001);
}

function anomalyThreshold(measurement: Measurement) {
  if (measurement.metricKind === "error_rate") return 0.5;
  if (measurement.metricKind === "slo_availability") return 0.005;
  return 0.25;
}

function isMeaningful(measurement: Measurement, baseline: number, delta: number) {
  if (measurement.metricKind === "error_rate") return delta >= 0.5 && measurement.value - baseline >= 0.005;
  if (measurement.metricKind === "slo_availability") return baseline - measurement.value >= 0.005;
  return delta >= anomalyThreshold(measurement);
}

export function detectHealthAnomalies(workspaceId: string, baselines = establishHealthBaselines(workspaceId)): HealthAnomaly[] {
  const services = listServices(workspaceId);
  const signals = listSignals(workspaceId);
  const baselineByKey = new Map(baselines.map((baseline) => [`${baseline.serviceId}:${baseline.metricName}`, baseline]));
  const save = db.prepare(
    `INSERT INTO health_anomalies
      (id, workspace_id, service_id, incident_id, signal_id, metric_name, metric_kind, observed_value, baseline_value, delta_ratio, threshold, severity, explanation, observed_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (workspace_id, signal_id, metric_name) DO UPDATE SET
       incident_id = excluded.incident_id, observed_value = excluded.observed_value, baseline_value = excluded.baseline_value,
       delta_ratio = excluded.delta_ratio, threshold = excluded.threshold, severity = excluded.severity, explanation = excluded.explanation,
       observed_at = excluded.observed_at, created_at = excluded.created_at`,
  );
  for (const signal of signals) {
    const service = findService(services, signal.service_name);
    const measurement = measurementForSignal(signal);
    if (!service || !measurement) continue;
    const baseline = baselineByKey.get(`${service.id}:${measurement.metricName}`);
    if (!baseline) continue;
    const observedAt = new Date(signal.observed_at).getTime();
    const isRecent = Number.isFinite(observedAt) && observedAt >= new Date(baseline.windowEnd).getTime();
    if (!signal.incident_id && !isRecent) continue;
    const delta = anomalyDelta(measurement, baseline.baselineValue);
    if (!isMeaningful(measurement, baseline.baselineValue, delta)) continue;
    const severity = delta >= 1 || (measurement.metricKind === "error_rate" && measurement.value - baseline.baselineValue >= 0.03) ? "high" : "medium";
    const explanation = measurement.metricKind === "slo_availability"
      ? `${measurement.metricName} fell from ${baseline.baselineValue.toFixed(3)} to ${measurement.value.toFixed(3)}.`
      : `${measurement.metricName} moved from ${baseline.baselineValue.toFixed(3)} to ${measurement.value.toFixed(3)} (${Math.round(delta * 100)}% above baseline).`;
    save.run(makeId("anom"), workspaceId, service.id, signal.incident_id, signal.id, measurement.metricName, measurement.metricKind, measurement.value, baseline.baselineValue, delta, anomalyThreshold(measurement), severity, explanation, signal.observed_at, nowIso());
  }
  const rows = db.prepare(
    `SELECT a.*, s.name AS service_name FROM health_anomalies a
     JOIN services s ON s.id = a.service_id AND s.workspace_id = a.workspace_id
     WHERE a.workspace_id = ? ORDER BY a.observed_at DESC`,
  ).all(workspaceId) as Array<{ id: string; workspace_id: string; service_id: string; service_name: string; incident_id: string | null; signal_id: string; metric_name: string; metric_kind: string; observed_value: number; baseline_value: number; delta_ratio: number; threshold: number; severity: string; explanation: string; observed_at: string }>;
  return rows.map((row) => ({ id: row.id, workspaceId: row.workspace_id, serviceId: row.service_id, serviceName: row.service_name, incidentId: row.incident_id, signalId: row.signal_id, metricName: row.metric_name, metricKind: row.metric_kind, observedValue: row.observed_value, baselineValue: row.baseline_value, deltaRatio: row.delta_ratio, threshold: row.threshold, severity: row.severity, explanation: row.explanation, observedAt: row.observed_at, evidenceRef: `${row.metric_kind}:${row.signal_id}` }));
}

function inIncidentWindow(value: string, incidentStart: string, incidentDetected: string) {
  const timestamp = new Date(value).getTime();
  const start = new Date(incidentStart).getTime() - 30 * 60_000;
  const end = new Date(incidentDetected).getTime() + 90 * 60_000;
  return Number.isFinite(timestamp) && timestamp >= start && timestamp <= end;
}

function sourceUrlForEvidence(workspaceId: string, incidentId: string, reference: string) {
  const [kind, ref] = reference.split(":", 2);
  if (kind === "deployment") return (db.prepare("SELECT url FROM deployments WHERE workspace_id = ? AND id = ?").get(workspaceId, ref) as { url: string | null } | undefined)?.url ?? null;
  if (kind === "change") return (db.prepare("SELECT url FROM changes WHERE workspace_id = ? AND id = ?").get(workspaceId, ref) as { url: string | null } | undefined)?.url ?? null;
  const timeline = db.prepare("SELECT source_url FROM timeline_events te JOIN incidents i ON i.id = te.incident_id WHERE i.workspace_id = ? AND te.incident_id = ? AND te.evidence_ref = ? LIMIT 1").get(workspaceId, incidentId, ref) as { source_url: string | null } | undefined;
  return timeline?.source_url ?? null;
}

function evidenceKind(reference: string) {
  const prefix = reference.split(":", 1)[0];
  if (["deployment", "change", "metric", "trace", "log", "runbook", "signal"].includes(prefix)) return prefix;
  return "signal";
}

function persistHypothesis(workspaceId: string, incidentId: string, hypothesis: RankedHypothesis, createdBy = "detector:baseline-v2") {
  const timestamp = nowIso();
  db.prepare(
    `INSERT INTO hypotheses (id, workspace_id, incident_id, title, summary, status, confidence, is_abstention, created_by, created_at, updated_at, rank, factors_json, abstention_reason)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (id) DO UPDATE SET title = excluded.title, summary = excluded.summary, status = excluded.status,
       confidence = excluded.confidence, is_abstention = excluded.is_abstention, updated_at = excluded.updated_at,
       rank = excluded.rank, factors_json = excluded.factors_json, abstention_reason = excluded.abstention_reason`,
  ).run(hypothesis.id, workspaceId, incidentId, hypothesis.title, hypothesis.summary, hypothesis.status, hypothesis.confidence, hypothesis.isAbstention ? 1 : 0, createdBy, timestamp, timestamp, hypothesis.rank, JSON.stringify(hypothesis.factors), hypothesis.abstentionReason ?? null);
  db.prepare("DELETE FROM hypothesis_evidence WHERE workspace_id = ? AND hypothesis_id = ?").run(workspaceId, hypothesis.id);
  const insertEvidence = db.prepare("INSERT INTO hypothesis_evidence (id, workspace_id, hypothesis_id, evidence_kind, evidence_ref, relationship, weight, source_url, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
  for (const [index, reference] of hypothesis.evidenceRefs.entries()) {
    insertEvidence.run(makeId("hyp_ev"), workspaceId, hypothesis.id, evidenceKind(reference), reference.split(":").slice(1).join(":"), "contributes to a ranked hypothesis; does not prove causality", Math.max(0.1, hypothesis.confidence - index * 0.04), sourceUrlForEvidence(workspaceId, incidentId, reference), timestamp);
  }
}

export function rankCauseHypotheses(workspaceId: string, incidentId: string, anomalies = detectHealthAnomalies(workspaceId)): RankedHypothesis[] {
  const incident = db.prepare("SELECT i.*, s.name AS service_name, s.slug AS service_slug FROM incidents i JOIN services s ON s.id = i.service_id WHERE i.workspace_id = ? AND i.id = ?").get(workspaceId, incidentId) as { id: string; service_id: string; service_name: string; service_slug: string; started_at: string; detected_at: string } | undefined;
  if (!incident) return [];
  const incidentAnomalies = anomalies.filter((anomaly) => anomaly.incidentId === incidentId || (anomaly.serviceId === incident.service_id && inIncidentWindow(anomaly.observedAt, incident.started_at, incident.detected_at)));
  const deployments = db.prepare(
    `SELECT d.id, d.version, d.status, d.started_at, d.completed_at, d.url, c.id AS change_id, c.sha, c.title AS change_title, c.risk_label
     FROM deployments d JOIN changes c ON c.id = d.change_id AND c.workspace_id = d.workspace_id
     WHERE d.workspace_id = ? AND d.service_id = ? ORDER BY d.started_at DESC`,
  ).all(workspaceId, incident.service_id) as Array<{ id: string; version: string; status: string; started_at: string; completed_at: string | null; url: string | null; change_id: string; sha: string; change_title: string; risk_label: string }>;
  const nearbyDeployments = deployments.filter((deployment) => inIncidentWindow(deployment.started_at, incident.started_at, incident.detected_at));
  const dependencyRows = db.prepare(
    `SELECT upstream.id, upstream.name, upstream.slug FROM service_dependencies sd
     JOIN services upstream ON upstream.id = sd.upstream_service_id AND upstream.workspace_id = sd.workspace_id
     WHERE sd.workspace_id = ? AND sd.downstream_service_id = ?`,
  ).all(workspaceId, incident.service_id) as Array<{ id: string; name: string; slug: string }>;
  const candidates: RankedHypothesis[] = [];
  for (const deployment of nearbyDeployments) {
    const timingDistance = Math.abs(new Date(deployment.started_at).getTime() - new Date(incident.started_at).getTime());
    const timing = Math.max(0, 1 - timingDistance / (90 * 60_000));
    const signalChange = Math.min(1, incidentAnomalies.length / 3);
    const risk = deployment.risk_label === "elevated" ? 1 : deployment.risk_label === "high" ? 0.9 : 0.55;
    const confidence = Math.min(0.92, 0.28 + timing * 0.34 + signalChange * 0.28 + risk * 0.1);
    const evidenceRefs = [`deployment:${deployment.id}`, `change:${deployment.change_id}`, ...incidentAnomalies.slice(0, 4).map((anomaly) => anomaly.evidenceRef)];
    candidates.push({ id: `hyp_${incidentId}_baseline_deployment_${deployment.id}`, incidentId, rank: 1, title: `Deployment ${deployment.version} (${deployment.sha}) — ${deployment.change_title} is the leading cause candidate`, summary: `The ${deployment.version} rollout is temporally aligned with the incident and the observed service health changes. This is a ranked hypothesis, not proof of causality.`, status: "uncertain", confidence, isAbstention: false, factors: [{ name: "timing", value: timing, explanation: "Deployment started near the incident window.", evidenceRefs: [`deployment:${deployment.id}`] }, { name: "metric_change", value: signalChange, explanation: `${incidentAnomalies.length} meaningful health changes are linked to this incident window.`, evidenceRefs: incidentAnomalies.slice(0, 4).map((anomaly) => anomaly.evidenceRef) }, { name: "change_risk", value: risk, explanation: `Change risk is labeled ${deployment.risk_label}.`, evidenceRefs: [`change:${deployment.change_id}`] }], evidenceRefs });
  }
  for (const dependency of dependencyRows) {
    const dependencyAnomalies = anomalies.filter((anomaly) => anomaly.serviceId === dependency.id && inIncidentWindow(anomaly.observedAt, incident.started_at, incident.detected_at));
    const path = dependencyAnomalies.length ? 0.85 : 0.45;
    const confidence = Math.min(0.79, 0.22 + path * 0.38 + Math.min(1, dependencyAnomalies.length / 2) * 0.25);
    const evidenceRefs = [`service:${dependency.id}`, ...dependencyAnomalies.slice(0, 3).map((anomaly) => anomaly.evidenceRef)];
    candidates.push({ id: `hyp_${incidentId}_baseline_dependency_${dependency.id}`, incidentId, rank: 1, title: `Upstream dependency ${dependency.name} may be contributing`, summary: dependencyAnomalies.length ? `${dependency.name} shows health changes within the same incident window, so the dependency path remains plausible.` : `The service graph includes ${dependency.name} upstream of ${incident.service_name}, but no correlated anomaly is currently recorded.`, status: "uncertain", confidence, isAbstention: false, factors: [{ name: "dependency_path", value: 1, explanation: `${dependency.name} is an upstream dependency of ${incident.service_name}.`, evidenceRefs: [`service:${dependency.id}`] }, { name: "observed_dependency_change", value: dependencyAnomalies.length ? 0.85 : 0.2, explanation: dependencyAnomalies.length ? `${dependencyAnomalies.length} dependency signal changes overlap the incident window.` : "No dependency metric change is linked yet.", evidenceRefs: dependencyAnomalies.slice(0, 3).map((anomaly) => anomaly.evidenceRef) }], evidenceRefs });
  }
  if (incidentAnomalies.length) {
    const evidenceRefs = incidentAnomalies.slice(0, 5).map((anomaly) => anomaly.evidenceRef);
    candidates.push({ id: `hyp_${incidentId}_baseline_signal`, incidentId, rank: 1, title: "The observed health signal change is confirmed; cause remains open", summary: "The detector found meaningful deviations from the service baseline, but the available change and dependency evidence is not sufficient to name a causal change with confidence.", status: "uncertain", confidence: Math.min(0.68, 0.28 + incidentAnomalies.length * 0.08), isAbstention: false, factors: [{ name: "metric_change", value: Math.min(1, incidentAnomalies.length / 3), explanation: `${incidentAnomalies.length} baseline deviations were detected.`, evidenceRefs }], evidenceRefs });
  }
  candidates.sort((left, right) => right.confidence - left.confidence);
  const ranked = candidates.slice(0, 3).map((candidate, index) => ({ ...candidate, rank: index + 1 }));
  const output = ranked.length && ranked[0].confidence >= 0.45
    ? ranked
    : [{ id: `hyp_${incidentId}_baseline_abstain`, incidentId, rank: 1, title: "Insufficient evidence to rank a likely cause", summary: "The detector observed too little correlated change, dependency, or deployment evidence to name a plausible cause. It is abstaining until more evidence is available.", status: "abstain" as const, confidence: 0.2, isAbstention: true, factors: [], evidenceRefs: incidentAnomalies.slice(0, 3).map((anomaly) => anomaly.evidenceRef), abstentionReason: "No candidate cleared the minimum evidence threshold." }];
  for (const hypothesis of output) persistHypothesis(workspaceId, incidentId, hypothesis);
  return output;
}

export function persistRankedHypotheses(workspaceId: string, incidentId: string, hypotheses: RankedHypothesis[], createdBy: string) {
  for (const hypothesis of hypotheses) persistHypothesis(workspaceId, incidentId, hypothesis, createdBy);
}

function maybeCreateIncident(workspaceId: string, anomalies: HealthAnomaly[]) {
  const grouped = new Map<string, HealthAnomaly[]>();
  for (const anomaly of anomalies.filter((item) => !item.incidentId)) {
    const list = grouped.get(anomaly.serviceId) ?? [];
    list.push(anomaly);
    grouped.set(anomaly.serviceId, list);
  }
  const created: string[] = [];
  for (const [serviceId, serviceAnomalies] of grouped) {
    if (serviceAnomalies.length < 2) continue;
    const service = db.prepare("SELECT name, slug FROM services WHERE workspace_id = ? AND id = ?").get(workspaceId, serviceId) as { name: string; slug: string } | undefined;
    if (!service) continue;
    const active = db.prepare("SELECT id FROM incidents WHERE workspace_id = ? AND service_id = ? AND status NOT IN ('resolved', 'closed') LIMIT 1").get(workspaceId, serviceId) as { id: string } | undefined;
    if (active) continue;
    const first = serviceAnomalies.slice().sort((left, right) => left.observedAt.localeCompare(right.observedAt))[0];
    const id = makeId("inc");
    const key = `AUTO-${service.slug.toUpperCase().replace(/[^A-Z0-9]+/g, "-").slice(0, 24)}-${new Date(first.observedAt).toISOString().slice(0, 10).replaceAll("-", "")}`;
    db.prepare("INSERT OR IGNORE INTO incidents (id, workspace_id, key, title, service_id, severity, status, started_at, detected_at, summary, impact) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(id, workspaceId, key, `${service.name} health degradation`, serviceId, serviceAnomalies.some((item) => item.severity === "high") ? "SEV-2" : "SEV-3", "investigating", first.observedAt, nowIso(), `The deterministic detector found ${serviceAnomalies.length} meaningful changes from the ${service.name} baseline.`, "Impact is not yet quantified; investigation is required.");
    for (const anomaly of serviceAnomalies) {
      db.prepare("UPDATE health_anomalies SET incident_id = ? WHERE workspace_id = ? AND id = ?").run(id, workspaceId, anomaly.id);
      db.prepare("INSERT INTO timeline_events (id, incident_id, occurred_at, type, title, description, source_url, evidence_kind, evidence_ref) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(makeId("evt"), id, anomaly.observedAt, "detected", `Baseline deviation detected: ${anomaly.metricName}`, anomaly.explanation, null, anomaly.metricKind, anomaly.evidenceRef.split(":").slice(1).join(":"));
    }
    created.push(id);
  }
  return created;
}

export function runHealthDetection(workspaceId: string) {
  const baselines = establishHealthBaselines(workspaceId);
  const anomalies = detectHealthAnomalies(workspaceId, baselines);
  const createdIncidentIds = maybeCreateIncident(workspaceId, anomalies);
  const activeIncidents = db.prepare("SELECT id FROM incidents WHERE workspace_id = ? AND status NOT IN ('resolved', 'closed') ORDER BY detected_at DESC").all(workspaceId) as Array<{ id: string }>;
  const hypotheses = activeIncidents.flatMap((incident) => rankCauseHypotheses(workspaceId, incident.id, anomalies));
  return { baselines, anomalies, createdIncidentIds, hypotheses };
}

export function getIncidentDetectionSummary(workspaceId: string, incidentId: string) {
  const anomalies = detectHealthAnomalies(workspaceId).filter((anomaly) => anomaly.incidentId === incidentId);
  const incident = db.prepare("SELECT detected_at FROM incidents WHERE workspace_id = ? AND id = ?").get(workspaceId, incidentId) as { detected_at: string } | undefined;
  const lags = incident ? anomalies.map((anomaly) => Math.max(0, new Date(incident.detected_at).getTime() - new Date(anomaly.observedAt).getTime())).filter(Number.isFinite) : [];
  return { anomalies, detectionLagMs: lags.length ? Math.min(...lags) : null };
}
