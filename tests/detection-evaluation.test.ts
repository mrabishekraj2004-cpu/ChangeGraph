import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";

let dbModule: typeof import("../src/lib/db");
let detectionModule: typeof import("../src/lib/detection");
let evaluationsModule: typeof import("../src/lib/evaluations");
let tempDirectory: string;

before(async () => {
  tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "changegraph-detection-test-"));
  process.env.AUTH_SECRET = "test-secret-that-is-at-least-32-characters-long";
  process.env.CHANGEGRAPH_DB_PATH = path.join(tempDirectory, "changegraph.db");
  dbModule = await import("../src/lib/db");
  detectionModule = await import("../src/lib/detection");
  evaluationsModule = await import("../src/lib/evaluations");
});

after(() => {
  dbModule.db.close();
  fs.rmSync(tempDirectory, { recursive: true, force: true });
});

describe("ChangeGraph detection and evaluation", () => {
  test("computes workspace-scoped baselines and ranks evidence-linked causes", () => {
    dbModule.seedDemoData();

    const result = detectionModule.runHealthDetection("ws_northstar_demo");
    const incident = detectionModule.getIncidentDetectionSummary("ws_northstar_demo", "inc_1047");

    assert.ok(result.baselines.length >= 2);
    assert.ok(result.anomalies.length >= 2);
    assert.ok(incident.anomalies.length >= 2);
    assert.ok(incident.detectionLagMs !== null);

    const deploymentHypothesis = result.hypotheses.find((hypothesis) => hypothesis.incidentId === "inc_1047" && hypothesis.evidenceRefs.some((ref) => ref.startsWith("deployment:")));
    assert.ok(deploymentHypothesis);
    assert.equal(deploymentHypothesis?.status, "uncertain");
    assert.equal(deploymentHypothesis?.isAbstention, false);
    assert.ok(deploymentHypothesis?.factors.some((factor) => factor.name === "timing"));
    assert.ok(deploymentHypothesis?.evidenceRefs.every((ref) => ref.includes(":")));
  });

  test("does not return data for a workspace that does not exist", () => {
    const result = detectionModule.runHealthDetection("workspace-not-found");
    assert.deepEqual(result.baselines, []);
    assert.deepEqual(result.anomalies, []);
    assert.deepEqual(result.createdIncidentIds, []);
    assert.deepEqual(result.hypotheses, []);
  });

  test("replays seeded evaluation cases and persists declared metrics", () => {
    dbModule.seedDemoData();

    const replay = evaluationsModule.runEvaluation("ws_northstar_demo", "eval_regression_suite");
    assert.ok(replay);
    assert.equal(replay?.cases.length, 3);
    assert.ok(replay?.metrics.top3Accuracy !== undefined);
    assert.ok(replay?.metrics.evidenceCoverage !== undefined);
    assert.ok(replay?.metrics.appropriateAbstention !== undefined);
    assert.ok(replay?.cases.every((item) => item.evidenceCoverage >= 0 && item.evidenceCoverage <= 1));

    const stored = dbModule.db.prepare("SELECT status, top3_accuracy, evidence_coverage, abstention_accuracy FROM evaluation_runs WHERE workspace_id = ? AND id = ?").get("ws_northstar_demo", replay!.runId) as { status: string; top3_accuracy: number | null; evidence_coverage: number | null; abstention_accuracy: number | null } | undefined;
    assert.equal(stored?.status, "succeeded");
    assert.equal(stored?.top3_accuracy, replay?.metrics.top3Accuracy);
    assert.equal(stored?.evidence_coverage, replay?.metrics.evidenceCoverage);
    assert.equal(stored?.abstention_accuracy, replay?.metrics.appropriateAbstention);
  });
});
