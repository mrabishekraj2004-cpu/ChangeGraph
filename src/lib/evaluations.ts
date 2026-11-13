import { randomUUID } from "node:crypto";
import { getIncidentDetectionSummary, rankCauseHypotheses, runHealthDetection, type RankedHypothesis } from "./detection";
import { db, getEvaluationCases, listEvaluations, nowIso } from "./db";

type EvaluationCase = ReturnType<typeof getEvaluationCases>[number] & { expected_abstention: number };

type CaseResult = {
  id: string;
  incidentKey: string;
  expectedCause: string;
  expectedAbstention: boolean;
  status: "pass" | "review";
  confidence: number;
  top3Hit: boolean;
  evidenceCoverage: number;
  detectionLagMs: number | null;
  abstentionCorrect: boolean;
  predicted: Array<{ rank: number; title: string; status: string; confidence: number }>;
  evidenceRefs: string[];
};

export type EvaluationReplay = {
  runId: string;
  passRate: number;
  metrics: {
    top3Accuracy: number;
    evidenceCoverage: number;
    detectionLagMs: number | null;
    appropriateAbstention: number;
  };
  cases: CaseResult[];
  startedAt: string;
  completedAt: string;
};

function normalize(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function causeTokens(expectedCause: string) {
  return normalize(expectedCause)
    .split(" ")
    .filter((token) => token.length > 2);
}

function hypothesisText(hypothesis: RankedHypothesis) {
  return normalize([
    hypothesis.title,
    hypothesis.summary,
    ...hypothesis.factors.map((factor) => `${factor.name} ${factor.explanation}`),
  ].join(" "));
}

function expectedCauseMatches(expectedCause: string, hypotheses: RankedHypothesis[]) {
  const tokens = causeTokens(expectedCause);
  if (!tokens.length) return false;
  return hypotheses.some((hypothesis) => {
    const text = hypothesisText(hypothesis);
    return tokens.every((token) => text.includes(token));
  });
}

function referenceExists(workspaceId: string, incidentId: string, reference: string) {
  const [kind, ref] = reference.split(":", 2);
  if (!ref) return false;
  if (kind === "deployment") return Boolean(db.prepare("SELECT 1 FROM deployments WHERE workspace_id = ? AND id = ?").get(workspaceId, ref));
  if (kind === "change") return Boolean(db.prepare("SELECT 1 FROM changes WHERE workspace_id = ? AND id = ?").get(workspaceId, ref));
  if (kind === "service") return Boolean(db.prepare("SELECT 1 FROM services WHERE workspace_id = ? AND id = ?").get(workspaceId, ref));
  if (kind === "runbook") return Boolean(db.prepare("SELECT 1 FROM runbooks WHERE workspace_id = ? AND slug = ?").get(workspaceId, ref));
  if (kind === "incident") return Boolean(db.prepare("SELECT 1 FROM incidents WHERE workspace_id = ? AND id = ?").get(workspaceId, ref));
  if (kind === "telemetry") return Boolean(db.prepare("SELECT 1 FROM telemetry_references WHERE workspace_id = ? AND external_ref = ?").get(workspaceId, ref));
  if (kind === "trace" || kind === "log" || kind === "metric") return Boolean(db.prepare("SELECT 1 FROM timeline_events te JOIN incidents i ON i.id = te.incident_id WHERE i.workspace_id = ? AND te.incident_id = ? AND te.evidence_ref = ?").get(workspaceId, incidentId, ref));
  return Boolean(db.prepare("SELECT 1 FROM signals WHERE workspace_id = ? AND id = ?").get(workspaceId, ref));
}

function evidenceCoverage(workspaceId: string, incidentId: string, hypotheses: RankedHypothesis[]) {
  const claims = hypotheses.filter((hypothesis) => !hypothesis.isAbstention);
  if (!claims.length) return 1;
  const grounded = claims.filter((hypothesis) => hypothesis.evidenceRefs.length > 0 && hypothesis.evidenceRefs.every((reference) => {
    const [kind, ref] = reference.split(":", 2);
    if (kind === "error_rate" || kind === "latency_ms" || kind === "slo_availability" || kind === "slo_burn_rate") {
      return Boolean(db.prepare("SELECT 1 FROM signals WHERE workspace_id = ? AND id = ?").get(workspaceId, ref));
    }
    return referenceExists(workspaceId, incidentId, reference);
  }));
  return grounded.length / claims.length;
}

function casePasses(item: EvaluationCase, hypotheses: RankedHypothesis[], top3Hit: boolean, abstentionCorrect: boolean, coverage: number) {
  if (item.expected_abstention) return abstentionCorrect && coverage >= 1;
  return top3Hit && coverage >= 1 && hypotheses.some((hypothesis) => !hypothesis.isAbstention);
}

export function runEvaluation(workspaceId: string, evaluationId: string): EvaluationReplay | null {
  const evaluation = listEvaluations(workspaceId).find((item) => item.id === evaluationId);
  if (!evaluation) return null;
  const cases = getEvaluationCases(workspaceId, evaluationId) as EvaluationCase[];
  const runId = `evalrun_${randomUUID().replaceAll("-", "").slice(0, 18)}`;
  const startedAt = nowIso();
  db.prepare("INSERT INTO evaluation_runs (id, workspace_id, evaluation_id, status, total_cases, started_at) VALUES (?, ?, ?, ?, ?, ?)").run(runId, workspaceId, evaluationId, "running", cases.length, startedAt);

  try {
    const detection = runHealthDetection(workspaceId);
    const results = cases.map((item) => {
      const incident = db.prepare("SELECT id FROM incidents WHERE workspace_id = ? AND key = ?").get(workspaceId, item.incident_key) as { id: string } | undefined;
      const hypotheses = incident ? rankCauseHypotheses(workspaceId, incident.id, detection.anomalies) : [];
      const top3Hit = !item.expected_abstention && expectedCauseMatches(item.expected_cause, hypotheses.slice(0, 3));
      const abstentionCorrect = Boolean(item.expected_abstention) === Boolean(hypotheses[0]?.isAbstention);
      const coverage = incident ? evidenceCoverage(workspaceId, incident.id, hypotheses) : 0;
      const detectionLagMs = incident ? getIncidentDetectionSummary(workspaceId, incident.id).detectionLagMs : null;
      const confidence = hypotheses[0]?.confidence ?? 0;
      const status = casePasses(item, hypotheses, top3Hit, abstentionCorrect, coverage) ? "pass" : "review";
      return {
        id: item.id,
        incidentKey: item.incident_key,
        expectedCause: item.expected_cause,
        expectedAbstention: Boolean(item.expected_abstention),
        status,
        confidence,
        top3Hit,
        evidenceCoverage: coverage,
        detectionLagMs,
        abstentionCorrect,
        predicted: hypotheses.slice(0, 3).map((hypothesis) => ({ rank: hypothesis.rank, title: hypothesis.title, status: hypothesis.status, confidence: hypothesis.confidence })),
        evidenceRefs: [...new Set(hypotheses.flatMap((hypothesis) => hypothesis.evidenceRefs))],
      } satisfies CaseResult;
    });
    const nonAbstention = results.filter((item) => !item.expectedAbstention);
    const lagValues = results.map((item) => item.detectionLagMs).filter((value): value is number => value !== null);
    const metrics = {
      top3Accuracy: nonAbstention.length ? nonAbstention.filter((item) => item.top3Hit).length / nonAbstention.length : 0,
      evidenceCoverage: results.length ? results.reduce((sum, item) => sum + item.evidenceCoverage, 0) / results.length : 0,
      detectionLagMs: lagValues.length ? lagValues.reduce((sum, value) => sum + value, 0) / lagValues.length : null,
      appropriateAbstention: results.length ? results.filter((item) => item.abstentionCorrect).length / results.length : 0,
    };
    const passRate = results.length ? results.filter((item) => item.status === "pass").length / results.length : 0;
    const completedAt = nowIso();
    const details = JSON.stringify({ metrics, cases: results });
    const tx = db.transaction(() => {
      const insert = db.prepare("INSERT INTO evaluation_case_results (id, workspace_id, evaluation_run_id, evaluation_case_id, top3_hit, evidence_coverage, detection_lag_ms, abstention_expected, abstention_correct, predicted_json, evidence_refs_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
      for (const result of results) insert.run(`evalcase_${randomUUID().replaceAll("-", "").slice(0, 18)}`, workspaceId, runId, result.id, result.top3Hit ? 1 : 0, result.evidenceCoverage, result.detectionLagMs, result.expectedAbstention ? 1 : 0, result.abstentionCorrect ? 1 : 0, JSON.stringify(result.predicted), JSON.stringify(result.evidenceRefs), completedAt);
      for (const result of results) db.prepare("UPDATE evaluation_cases SET status = ?, confidence = ? WHERE id = ? AND evaluation_id = ?").run(result.status, result.confidence, result.id, evaluationId);
      db.prepare("UPDATE evaluation_runs SET status = ?, top3_accuracy = ?, evidence_coverage = ?, detection_lag_ms = ?, abstention_accuracy = ?, details_json = ?, completed_at = ? WHERE id = ? AND workspace_id = ?").run("succeeded", metrics.top3Accuracy, metrics.evidenceCoverage, metrics.detectionLagMs, metrics.appropriateAbstention, details, completedAt, runId, workspaceId);
      db.prepare("UPDATE evaluations SET pass_rate = ?, last_run_at = ? WHERE id = ? AND workspace_id = ?").run(passRate, completedAt, evaluationId, workspaceId);
    });
    tx();
    return { runId, passRate, metrics, cases: results, startedAt, completedAt };
  } catch (error) {
    db.prepare("UPDATE evaluation_runs SET status = ?, details_json = ?, completed_at = ? WHERE id = ? AND workspace_id = ?").run("failed", JSON.stringify({ error: error instanceof Error ? error.message : "Evaluation failed." }), nowIso(), runId, workspaceId);
    throw error;
  }
}
