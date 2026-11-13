import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { ingestEvent, processEvent } from "@/lib/event-processing";
import { parseChangeGraphEvent } from "@/lib/events";
import { identityRepository } from "@/lib/identity-repository";
import { mutationGuard } from "@/lib/security";

export async function POST(request: Request) {
  const blocked = mutationGuard(request, "events:ingest", { limit: 120, windowMs: 60_000 });
  if (blocked) return blocked;
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Request body must be valid JSON." }, { status: 400 });
  }
  const parsed = parseChangeGraphEvent(body);
  if (!parsed.success) return NextResponse.json({ error: "Invalid ChangeGraph event.", issues: parsed.error.issues }, { status: 400 });
  if (!await identityRepository.getWorkspaceForUser(user.id, parsed.data.workspaceId)) return NextResponse.json({ error: "Event workspace is not available to this user." }, { status: 403 });
  try {
    const accepted = ingestEvent(parsed.data, { "x-changegraph-user": user.id });
    const processed = processEvent(accepted.eventId);
    return NextResponse.json({ ...accepted, processed }, { status: accepted.duplicate ? 200 : 202 });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Event could not be accepted." }, { status: 500 });
  }
}
