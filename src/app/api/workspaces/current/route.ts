import { NextResponse } from "next/server";
import { z } from "zod";
import { getCurrentUser } from "@/lib/auth";
import { identityRepository } from "@/lib/identity-repository";
import { mutationGuard } from "@/lib/security";

const schema = z.object({ name: z.string().min(2).max(80), mode: z.enum(["production", "demo"]) });

export async function PATCH(request: Request) {
  const blocked = mutationGuard(request, "workspace:update", { limit: 30, windowMs: 60_000 });
  if (blocked) return blocked;
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Sign in required." }, { status: 401 });
  const workspace = await identityRepository.getWorkspaceForUser(user.id, user.workspace.id);
  if (!workspace || !["owner", "admin"].includes(workspace.role)) return NextResponse.json({ error: "Only workspace owners and admins can edit workspace settings." }, { status: 403 });
  let body: unknown;
  try { body = await request.json(); } catch { return NextResponse.json({ error: "Request body must be valid JSON." }, { status: 400 }); }
  const parsed = schema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "Enter a workspace name and choose a valid mode." }, { status: 400 });
  await identityRepository.updateWorkspace(workspace.id, parsed.data);
  await identityRepository.recordAuditEvent({ workspaceId: workspace.id, actorUserId: user.id, action: "workspace.updated", entityType: "workspace", entityId: workspace.id, metadata: { mode: parsed.data.mode } });
  return NextResponse.json({ ok: true });
}
