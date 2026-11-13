import { NextResponse } from "next/server";
import { z } from "zod";
import { seedIfNeeded } from "@/lib/db";
import { identityRepository } from "@/lib/identity-repository";
import { mutationGuard, sensitiveAuthRateLimit } from "@/lib/security";

const schema = z.object({ token: z.string().min(10), password: z.string().min(8) });

export async function POST(request: Request) {
  const blocked = mutationGuard(request, "auth:reset", sensitiveAuthRateLimit);
  if (blocked) return blocked;
  seedIfNeeded();
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Request body must be valid JSON." }, { status: 400 });
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "Use the reset link and enter an 8+ character password." }, { status: 400 });
  const match = await identityRepository.consumeEmailToken(parsed.data.token, "reset");
  if (!match) return NextResponse.json({ error: "That reset link is invalid or expired." }, { status: 400 });
  await identityRepository.updatePassword(match.user_id, parsed.data.password);
  await identityRepository.markTokenUsed(match.id);
  const workspace = await identityRepository.getWorkspaceForUser(match.user_id);
  if (workspace) await identityRepository.recordAuditEvent({ workspaceId: workspace.id, actorUserId: match.user_id, action: "auth.password_reset", entityType: "user", entityId: match.user_id, metadata: { sessionsRevoked: true } });
  return NextResponse.json({ redirect: "/login" });
}
