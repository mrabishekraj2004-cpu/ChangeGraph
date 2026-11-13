import { NextResponse } from "next/server";
import { endSession, getCurrentUser } from "@/lib/auth";
import { identityRepository } from "@/lib/identity-repository";

import { mutationGuard } from "@/lib/security";

export async function POST(request: Request) {
  const blocked = mutationGuard(request, "auth:logout", { limit: 30, windowMs: 60_000 });
  if (blocked) return blocked;
  const user = await getCurrentUser();
  if (user) await identityRepository.recordAuditEvent({ workspaceId: user.workspace.id, actorUserId: user.id, action: "auth.logout", entityType: "session", metadata: { method: "password" } });
  await endSession();
  return NextResponse.json({ ok: true });
}
