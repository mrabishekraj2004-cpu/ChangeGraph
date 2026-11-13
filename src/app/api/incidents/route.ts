import { NextResponse } from "next/server";
import { z } from "zod";
import { getCurrentUser } from "@/lib/auth";
import { createIncident, getServiceForWorkspace, seedIfNeeded } from "@/lib/db";
import { identityRepository } from "@/lib/identity-repository";
import { mutationGuard } from "@/lib/security";

const schema = z.object({ title: z.string().min(3), serviceId: z.string().min(1), severity: z.string().min(1), impact: z.string().min(4), summary: z.string().min(4) });

export async function POST(request: Request) {
  const blocked = mutationGuard(request, "incidents:create", { limit: 30, windowMs: 60_000 });
  if (blocked) return blocked;
  seedIfNeeded();
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Sign in required." }, { status: 401 });
  let body: unknown;
  try { body = await request.json(); } catch { return NextResponse.json({ error: "Request body must be valid JSON." }, { status: 400 }); }
  const parsed = schema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "Add a title, service, impact, and summary." }, { status: 400 });
  const workspace = await identityRepository.getWorkspaceForUser(user.id, user.workspace.id);
  if (!workspace || !["owner", "admin", "responder"].includes(workspace.role)) return NextResponse.json({ error: "Your workspace role cannot open incidents." }, { status: 403 });
  if (!getServiceForWorkspace(workspace.id, parsed.data.serviceId)) return NextResponse.json({ error: "That service does not belong to this workspace." }, { status: 400 });
  const incident = createIncident(workspace.id, parsed.data);
  await identityRepository.recordAuditEvent({ workspaceId: workspace.id, actorUserId: user.id, action: "incident.created", entityType: "incident", entityId: incident.id, metadata: { severity: parsed.data.severity, serviceId: parsed.data.serviceId } });
  return NextResponse.json(incident, { status: 201 });
}
