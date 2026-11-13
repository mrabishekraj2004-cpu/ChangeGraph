import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { getOperationalMetrics, getWorkerHeartbeat } from "@/lib/db";
import { identityRepository } from "@/lib/identity-repository";

function hasMetricsToken(request: Request) {
  const expected = process.env.CHANGEGRAPH_METRICS_TOKEN?.trim() || process.env.CHANGEGRAPH_INGEST_TOKEN?.trim();
  return Boolean(expected && request.headers.get("x-changegraph-metrics-token") === expected);
}

export async function GET(request: Request) {
  const user = await getCurrentUser();
  const tokenAccess = hasMetricsToken(request);
  if (!user && !tokenAccess) return NextResponse.json({ error: "Authentication or metrics token required." }, { status: 401 });
  if (user && !tokenAccess && !["owner", "admin"].includes(user.role)) return NextResponse.json({ error: "Owner or admin access required." }, { status: 403 });
  if (user && !await identityRepository.getWorkspaceForUser(user.id, user.workspace.id)) return NextResponse.json({ error: "Workspace is not available to this user." }, { status: 403 });
  if (!user && tokenAccess && !process.env.CHANGEGRAPH_INGEST_WORKSPACE_ID) return NextResponse.json({ error: "CHANGEGRAPH_INGEST_WORKSPACE_ID is required for token-based metrics." }, { status: 503 });
  const workspaceId = user?.workspace.id || process.env.CHANGEGRAPH_INGEST_WORKSPACE_ID!;
  const metrics = getOperationalMetrics(workspaceId);
  const worker = getWorkerHeartbeat("event-worker", Math.max(10_000, Number(process.env.CHANGEGRAPH_WORKER_STALE_MS || 30_000)));
  if (new URL(request.url).searchParams.get("format") === "prometheus") {
    const labels = `workspace_id="${workspaceId.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
    const workerStatus = worker.status === "healthy" ? 1 : 0;
    const lines = [
      `# HELP changegraph_services Number of services in the workspace`,
      `# TYPE changegraph_services gauge`,
      `changegraph_services{${labels}} ${metrics.services}`,
      `# HELP changegraph_open_incidents Number of unresolved incidents`,
      `# TYPE changegraph_open_incidents gauge`,
      `changegraph_open_incidents{${labels}} ${metrics.openIncidents}`,
      `# HELP changegraph_recent_deployments Number of deployments in the last 24 hours`,
      `# TYPE changegraph_recent_deployments gauge`,
      `changegraph_recent_deployments{${labels}} ${metrics.recentDeployments}`,
      `# HELP changegraph_event_inbox_events Events by inbox state`,
      `# TYPE changegraph_event_inbox_events gauge`,
      ...Object.entries(metrics.eventInbox).map(([status, value]) => `changegraph_event_inbox_events{${labels},status="${status}"} ${value}`),
      `# HELP changegraph_dead_letters Number of dead-letter events`,
      `# TYPE changegraph_dead_letters gauge`,
      `changegraph_dead_letters{${labels}} ${metrics.deadLetters}`,
      `# HELP changegraph_worker_healthy Whether the event worker has a fresh heartbeat`,
      `# TYPE changegraph_worker_healthy gauge`,
      `changegraph_worker_healthy{${labels}} ${workerStatus}`,
    ];
    return new NextResponse(`${lines.join("\n")}\n`, { headers: { "content-type": "text/plain; version=0.0.4; charset=utf-8", "cache-control": "no-store" } });
  }
  return NextResponse.json({
    workspaceId,
    generatedAt: new Date().toISOString(),
    metrics,
    worker,
  });
}
