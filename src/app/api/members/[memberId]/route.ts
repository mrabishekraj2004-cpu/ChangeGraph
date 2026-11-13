import { NextResponse } from "next/server";
import { z } from "zod";
import { getCurrentUser } from "@/lib/auth";
import { identityRepository } from "@/lib/identity-repository";
import { mutationGuard } from "@/lib/security";

const schema = z.object({ role: z.enum(["admin", "responder", "member"]) });

async function authorized() {
  const user = await getCurrentUser();
  if (!user) return null;
  const workspace = await identityRepository.getWorkspaceForUser(user.id, user.workspace.id);
  if (!workspace || !["owner", "admin"].includes(workspace.role)) return null;
  return { user, workspace };
}

export async function PATCH(request: Request, { params }: { params: Promise<{ memberId: string }> }) {
  const blocked = mutationGuard(request, "members:update", { limit: 30, windowMs: 60_000 });
  if (blocked) return blocked;
  const context = await authorized();
  if (!context) return NextResponse.json({ error: "Workspace admin access required." }, { status: 403 });
  let body: unknown;
  try { body = await request.json(); } catch { return NextResponse.json({ error: "Request body must be valid JSON." }, { status: 400 }); }
  const parsed = schema.safeParse(body);
  const { memberId } = await params;
  if (!parsed.success || !await identityRepository.updateWorkspaceMemberRole(context.workspace.id, memberId, parsed.data.role)) return NextResponse.json({ error: "Could not update that member." }, { status: 400 });
  await identityRepository.recordAuditEvent({ workspaceId: context.workspace.id, actorUserId: context.user.id, action: "membership.role_changed", entityType: "membership", entityId: memberId, metadata: { role: parsed.data.role } });
  return NextResponse.json({ ok: true });
}

export async function DELETE(request: Request, { params }: { params: Promise<{ memberId: string }> }) {
  const blocked = mutationGuard(request, "members:remove", { limit: 20, windowMs: 60_000 });
  if (blocked) return blocked;
  const context = await authorized();
  if (!context) return NextResponse.json({ error: "Workspace admin access required." }, { status: 403 });
  const { memberId } = await params;
  if (!await identityRepository.removeWorkspaceMember(context.workspace.id, memberId)) return NextResponse.json({ error: "The owner cannot be removed." }, { status: 400 });
  await identityRepository.recordAuditEvent({ workspaceId: context.workspace.id, actorUserId: context.user.id, action: "membership.removed", entityType: "membership", entityId: memberId });
  return NextResponse.json({ ok: true });
}
