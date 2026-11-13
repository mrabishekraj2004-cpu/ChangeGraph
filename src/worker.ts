import { processPendingEvents } from "./lib/event-processing";
import { touchWorkerHeartbeat } from "./lib/db";

const intervalMs = Math.max(1_000, Number(process.env.CHANGEGRAPH_WORKER_INTERVAL_MS || 5_000));
const batchSize = Math.max(1, Math.min(100, Number(process.env.CHANGEGRAPH_WORKER_BATCH_SIZE || 25)));

function runBatch() {
  try {
    const results = processPendingEvents(batchSize);
    const failedCount = results.filter((result) => result.status === "retrying" || result.status === "dead_letter").length;
    touchWorkerHeartbeat("event-worker", { batchSize: results.length, processedCount: results.filter((result) => result.status === "processed").length, failedCount });
    if (results.length > 0) {
      console.log(JSON.stringify({ component: "changegraph-event-worker", processed: results }));
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown worker failure";
    touchWorkerHeartbeat("event-worker", { error: message });
    console.error(JSON.stringify({ component: "changegraph-event-worker", error: message }));
  }
}

runBatch();
const timer = setInterval(runBatch, intervalMs);

function shutdown() {
  clearInterval(timer);
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
