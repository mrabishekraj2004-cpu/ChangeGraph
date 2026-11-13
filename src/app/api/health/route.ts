import { NextResponse } from "next/server";
import { db, getWorkerHeartbeat } from "@/lib/db";
import { currentMigrationVersion } from "@/lib/migrations";

export function GET() {
  try {
    db.prepare("SELECT 1 AS ok").get();
    const authConfigured = Boolean(process.env.AUTH_SECRET && process.env.AUTH_SECRET.length >= 32);
    const worker = getWorkerHeartbeat("event-worker", Math.max(10_000, Number(process.env.CHANGEGRAPH_WORKER_STALE_MS || 30_000)));
    const ready = authConfigured;
    return NextResponse.json(
      {
        status: ready ? "ok" : "degraded",
        database: "ready",
        storage: { provider: "sqlite", deploymentMode: "single_host", multiInstanceSafe: false },
        auth: authConfigured ? "configured" : "missing",
        migrationVersion: currentMigrationVersion,
        queue: "event-worker",
        worker,
        timestamp: new Date().toISOString(),
      },
      { status: ready ? 200 : 503 },
    );
  } catch {
    return NextResponse.json({ status: "down", database: "unavailable" }, { status: 503 });
  }
}
