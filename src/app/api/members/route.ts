import { NextResponse } from "next/server";
import { z } from "zod";
import { getCurrentUser } from "@/lib/auth";
import { identityRepository } from "@/lib/identity-repository";
import { mutationGuard } from "@/lib/security";

const schema = z.object({ email: z.string().email(), role: z.enum(["admin", "responder", "member"]) });

export async function GET() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Sign in required." }, { status: 401 });
  const workspace = await identityRepository.getWorkspaceForUser(user.id, user.workspace.id);
  if (!workspace) return NextResponse.json({ error: "Workspace not found." }, { status: 404 });
  return NextResponse.json({ members: await identityRepository.listWorkspaceMembers(workspace.id) });
}

export async function POST(request: Request) {
  const blocked = mutationGuard(request, "members:add", { limit: 30, windowMs: 60_000 });
  if (blocked) return blocked;
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Sign in required." }, { status: 401 });
  const workspace = await identityRepository.getWorkspaceForUser(user.id, user.workspace.id);
  if (!workspace || !["owner", "admin"].includes(workspace.role)) return NextResponse.json({ error: "Only workspace owners and admins can add members." }, { status: 403 });
  let body: unknown;
  try { body = await request.json(); } catch { return NextResponse.json({ error: "Request body must be valid JSON." }, { status: 400 }); }
  const parsed = schema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "Enter a valid email and role." }, { status: 400 });
  const result = await identityRepository.addWorkspaceMember(workspace.id, parsed.data.email, parsed.data.role);
  if (!result.ok && result.reason === "not_found") return NextResponse.json({ error: "That person must create a ChangeGraph account before they can be added." }, { status: 404 });
  if (!result.ok) return NextResponse.json({ error: "That person is already a member." }, { status: 409 });
  await identityRepository.recordAuditEvent({ workspaceId: workspace.id, actorUserId: user.id, action: "membership.added", entityType: "membership", metadata: { email: parsed.data.email.toLowerCase(), role: parsed.data.role } });
  return NextResponse.json({ ok: true }, { status: 201 });
}
