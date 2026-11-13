import { NextResponse } from "next/server";
import { z } from "zod";
import { getCurrentUser, switchCurrentWorkspace } from "@/lib/auth";
import { mutationGuard } from "@/lib/security";

const schema = z.object({ workspaceId: z.string().min(1) });

export async function POST(request: Request) {
  const blocked = mutationGuard(request, "workspace:switch", { limit: 60, windowMs: 60_000 });
  if (blocked) return blocked;
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Sign in required." }, { status: 401 });
  let body: unknown;
  try { body = await request.json(); } catch { return NextResponse.json({ error: "Request body must be valid JSON." }, { status: 400 }); }
  const parsed = schema.safeParse(body);
  if (!parsed.success || !(await switchCurrentWorkspace(parsed.data.workspaceId))) return NextResponse.json({ error: "You do not belong to that workspace." }, { status: 403 });
  return NextResponse.json({ ok: true });
}
