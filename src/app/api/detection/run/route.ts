import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { runHealthDetection } from "@/lib/detection";
import { seedIfNeeded } from "@/lib/db";
import { identityRepository } from "@/lib/identity-repository";
import { mutationGuard } from "@/lib/security";

export async function POST(request: Request) {
  const blocked = mutationGuard(request, "detection:run", { limit: 12, windowMs: 60_000 });
  if (blocked) return blocked;
  seedIfNeeded();
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Sign in required." }, { status: 401 });
  if (!["owner", "admin", "responder"].includes(user.role)) return NextResponse.json({ error: "Responder access is required to run detection." }, { status: 403 });
  const result = runHealthDetection(user.workspace.id);
  await identityRepository.recordAuditEvent({
    workspaceId: user.workspace.id,
    actorUserId: user.id,
    action: "detection.run",
    entityType: "workspace",
    entityId: user.workspace.id,
    metadata: { baselines: result.baselines.length, anomalies: result.anomalies.length, createdIncidentIds: result.createdIncidentIds },
  });
  return NextResponse.json({
    baselines: result.baselines.length,
    anomalies: result.anomalies.length,
    createdIncidentIds: result.createdIncidentIds,
    hypotheses: result.hypotheses.length,
  });
}
