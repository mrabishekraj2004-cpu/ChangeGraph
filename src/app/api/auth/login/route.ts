import { NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { seedIfNeeded } from "@/lib/db";
import { identityRepository } from "@/lib/identity-repository";
import { startSession } from "@/lib/auth";
import { authRateLimit, mutationGuard } from "@/lib/security";

const schema = z.object({ email: z.string().email(), password: z.string().min(8) });

export async function POST(request: Request) {
  const blocked = mutationGuard(request, "auth:login", authRateLimit);
  if (blocked) return blocked;
  seedIfNeeded();
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Request body must be valid JSON." }, { status: 400 });
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "Enter a valid email and an 8+ character password." }, { status: 400 });
  const user = await identityRepository.getUserByEmail(parsed.data.email);
  if (!user || !bcrypt.compareSync(parsed.data.password, user.password_hash)) return NextResponse.json({ error: "Email or password is incorrect." }, { status: 401 });
  if (!user.verified_at) return NextResponse.json({ error: "Verify your email before signing in." }, { status: 403 });
  const workspace = await identityRepository.getWorkspaceForUser(user.id);
  if (!workspace) return NextResponse.json({ error: "No workspace is available for this account." }, { status: 403 });
  await startSession(user.id, workspace.id);
  await identityRepository.recordAuditEvent({ workspaceId: workspace.id, actorUserId: user.id, action: "auth.login", entityType: "session", metadata: { method: "password" } });
  return NextResponse.json({ redirect: workspace.slug.startsWith("workspace-") ? "/onboarding" : "/overview" });
}
