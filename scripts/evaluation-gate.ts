async function main() {
  process.env.CHANGEGRAPH_DB_PATH = ":memory:";

  const { db, seedDemoData } = await import("../src/lib/db");
  const { runEvaluation } = await import("../src/lib/evaluations");

  try {
    seedDemoData();
    const replay = runEvaluation("ws_northstar_demo", "eval_regression_suite");
    if (!replay) throw new Error("The seeded regression evaluation was not found.");

    const thresholds = {
      allCasesPass: true,
      top3Accuracy: 1,
      evidenceCoverage: 1,
      appropriateAbstention: 1,
      maximumAverageDetectionLagMs: 120_000,
    };
    const passed = replay.cases.every((item) => item.status === "pass")
      && replay.metrics.top3Accuracy >= thresholds.top3Accuracy
      && replay.metrics.evidenceCoverage >= thresholds.evidenceCoverage
      && replay.metrics.appropriateAbstention >= thresholds.appropriateAbstention
      && replay.metrics.detectionLagMs !== null
      && replay.metrics.detectionLagMs <= thresholds.maximumAverageDetectionLagMs;

    console.log(JSON.stringify({
      benchmark: "seeded-deterministic-regression",
      interpretation: "Regression gate for three seeded examples; not a real-world quality estimate.",
      status: passed ? "passed" : "failed",
      thresholds,
      actual: {
        caseCount: replay.cases.length,
        passRate: replay.passRate,
        ...replay.metrics,
      },
      cases: replay.cases.map(({ incidentKey, status, top3Hit, evidenceCoverage, abstentionCorrect, detectionLagMs }) => ({
        incidentKey,
        status,
        top3Hit,
        evidenceCoverage,
        abstentionCorrect,
        detectionLagMs,
      })),
    }));

    if (!passed) process.exitCode = 1;
  } finally {
    db.close();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Evaluation gate failed.");
  process.exitCode = 1;
});
