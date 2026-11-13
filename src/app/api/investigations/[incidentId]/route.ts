import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { getIncident, seedIfNeeded } from "@/lib/db";
import { identityRepository } from "@/lib/identity-repository";
import { getStoredOrRunInvestigation, runModelInvestigation } from "@/lib/agent";
import { mutationGuard } from "@/lib/security";

export async function POST(request: Request, { params }: { params: Promise<{ incidentId: string }> }) {
  const blocked = mutationGuard(request, "investigations:run", { limit: 12, windowMs: 60_000 });
  if (blocked) return blocked;
  seedIfNeeded();
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Sign in required." }, { status: 401 });
  const { incidentId } = await params;
  if (!getIncident(user.workspace.id, incidentId)) return NextResponse.json({ error: "Incident not found." }, { status: 404 });
  let mode = "baseline";
  try {
    const body = await request.json() as { mode?: string };
    if (body.mode === "model") mode = "model";
  } catch {
    // Empty POST bodies replay the deterministic baseline.
  }
  const investigation = mode === "model" ? await runModelInvestigation(user.workspace.id, incidentId) : getStoredOrRunInvestigation(user.workspace.id, incidentId);
  if (investigation) {
    await identityRepository.recordAuditEvent({
      workspaceId: user.workspace.id,
      actorUserId: user.id,
      action: "investigation.run",
      entityType: "incident",
      entityId: incidentId,
      metadata: { mode, status: investigation.status, confidence: investigation.confidence },
    });
  }
  return NextResponse.json({ investigation });
}
