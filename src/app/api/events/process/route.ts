import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { identityRepository } from "@/lib/identity-repository";
import { processPendingEvents } from "@/lib/event-processing";
import { mutationGuard } from "@/lib/security";

function hasIngestToken(request: Request) {
  const expected = process.env.CHANGEGRAPH_INGEST_TOKEN;
  return Boolean(expected && request.headers.get("x-changegraph-ingest-token") === expected);
}

export async function POST(request: Request) {
  const blocked = mutationGuard(request, "events:process", { limit: 60, windowMs: 60_000 });
  if (blocked) return blocked;
  const user = await getCurrentUser();
  const tokenAccess = hasIngestToken(request);
  if (!user && !tokenAccess) return NextResponse.json({ error: "Authentication or ingest token required." }, { status: 401 });
  if (user && !tokenAccess && !["owner", "admin"].includes(user.role)) return NextResponse.json({ error: "Owner or admin access required." }, { status: 403 });
  if (user && !await identityRepository.getWorkspaceForUser(user.id, user.workspace.id)) return NextResponse.json({ error: "Workspace is not available to this user." }, { status: 403 });
  if (!user && tokenAccess && !process.env.CHANGEGRAPH_INGEST_WORKSPACE_ID) return NextResponse.json({ error: "CHANGEGRAPH_INGEST_WORKSPACE_ID is required for token-based processing." }, { status: 503 });
  const url = new URL(request.url);
  const limit = Number(url.searchParams.get("limit") || 25);
  const workspaceId = user ? user.workspace.id : process.env.CHANGEGRAPH_INGEST_WORKSPACE_ID;
  const results = processPendingEvents(Number.isFinite(limit) ? limit : 25, workspaceId);
  return NextResponse.json({ processed: results });
}
