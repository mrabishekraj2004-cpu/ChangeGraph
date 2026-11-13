import { NextResponse } from "next/server";
import { z } from "zod";
import { getCurrentUser, switchCurrentWorkspace } from "@/lib/auth";
import { seedIfNeeded } from "@/lib/db";
import { identityRepository } from "@/lib/identity-repository";
import { mutationGuard } from "@/lib/security";

const schema = z.object({ name: z.string().min(2).max(80), mode: z.enum(["production", "demo"]) });

export async function POST(request: Request) {
  const blocked = mutationGuard(request, "workspace:create", { limit: 10, windowMs: 60_000 });
  if (blocked) return blocked;
  seedIfNeeded();
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Sign in required." }, { status: 401 });
  let body: unknown;
  try { body = await request.json(); } catch { return NextResponse.json({ error: "Request body must be valid JSON." }, { status: 400 }); }
  const parsed = schema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "Enter a workspace name and choose a valid mode." }, { status: 400 });
  const workspace = await identityRepository.createWorkspace(user.id, parsed.data);
  await switchCurrentWorkspace(workspace.id);
  await identityRepository.recordAuditEvent({ workspaceId: workspace.id, actorUserId: user.id, action: "workspace.created", entityType: "workspace", entityId: workspace.id, metadata: { mode: parsed.data.mode } });
  return NextResponse.json({ ...workspace, redirect: "/overview" }, { status: 201 });
}
