import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { identityRepository } from "@/lib/identity-repository";
import { processEvent, replayDeadLetter } from "@/lib/event-processing";
import { mutationGuard } from "@/lib/security";

function hasIngestToken(request: Request) {
  const expected = process.env.CHANGEGRAPH_INGEST_TOKEN;
  return Boolean(expected && request.headers.get("x-changegraph-ingest-token") === expected);
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const blocked = mutationGuard(request, "events:dead-letter-replay", { limit: 20, windowMs: 60_000 });
  if (blocked) return blocked;
  const user = await getCurrentUser();
  const tokenAccess = hasIngestToken(request);
  if (!user && !tokenAccess) return NextResponse.json({ error: "Authentication or ingest token required." }, { status: 401 });
  if (user && !tokenAccess && !["owner", "admin"].includes(user.role)) return NextResponse.json({ error: "Owner or admin access required." }, { status: 403 });
  const workspaceId = user?.workspace.id || process.env.CHANGEGRAPH_INGEST_WORKSPACE_ID;
  if (!workspaceId) return NextResponse.json({ error: "A workspace is required for dead-letter replay." }, { status: 503 });
  if (user && !await identityRepository.getWorkspaceForUser(user.id, workspaceId)) return NextResponse.json({ error: "Workspace is not available to this user." }, { status: 403 });
  const { id } = await params;
  const replayed = replayDeadLetter(workspaceId, id);
  if (!replayed) return NextResponse.json({ error: "Dead-letter event not found." }, { status: 404 });
  return NextResponse.json({ replayed: true, eventId: replayed.eventId, processed: processEvent(replayed.eventId) });
}
