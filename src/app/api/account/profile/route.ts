import { NextResponse } from "next/server";
import { z } from "zod";
import { getCurrentUser } from "@/lib/auth";
import { identityRepository } from "@/lib/identity-repository";
import { mutationGuard } from "@/lib/security";

const schema = z.object({ name: z.string().min(2).max(80) });

export async function PATCH(request: Request) {
  const blocked = mutationGuard(request, "account:profile", { limit: 30, windowMs: 60_000 });
  if (blocked) return blocked;
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Sign in required." }, { status: 401 });
  const parsed = schema.safeParse(await request.json());
  if (!parsed.success) return NextResponse.json({ error: "Enter a name with at least two characters." }, { status: 400 });
  await identityRepository.updateUserName(user.id, parsed.data.name);
  await identityRepository.recordAuditEvent({ workspaceId: user.workspace.id, actorUserId: user.id, action: "account.profile_updated", entityType: "user", entityId: user.id });
  return NextResponse.json({ ok: true });
}
