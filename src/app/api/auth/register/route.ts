import { NextResponse } from "next/server";
import { z } from "zod";
import { seedIfNeeded } from "@/lib/db";
import { identityRepository } from "@/lib/identity-repository";
import { authRateLimit, mutationGuard } from "@/lib/security";
import { sendTransactionalEmail } from "@/lib/email";

const schema = z.object({ name: z.string().min(2), email: z.string().email(), password: z.string().min(8) });

export async function POST(request: Request) {
  const blocked = mutationGuard(request, "auth:register", authRateLimit);
  if (blocked) return blocked;
  seedIfNeeded();
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Request body must be valid JSON." }, { status: 400 });
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "Add your name, a valid email, and an 8+ character password." }, { status: 400 });
  if (await identityRepository.getUserByEmail(parsed.data.email)) return NextResponse.json({ error: "An account with that email already exists." }, { status: 409 });
  const created = await identityRepository.createUser(parsed.data);
  await identityRepository.recordAuditEvent({ workspaceId: created.workspaceId, actorUserId: created.id, action: "auth.registered", entityType: "user", entityId: created.id, metadata: { emailDeliveryConfigured: Boolean(process.env.EMAIL_PROVIDER) } });
  const baseUrl = process.env.APP_URL?.trim() || new URL(request.url).origin;
  const verificationUrl = new URL(`/verify?token=${created.verificationToken}`, baseUrl).toString();
  const delivery = await sendTransactionalEmail({
    to: parsed.data.email,
    subject: "Verify your ChangeGraph workspace",
    text: `Open this link to verify your ChangeGraph account: ${verificationUrl}`,
    html: `<p>Open this link to verify your ChangeGraph account:</p><p><a href="${verificationUrl}">Verify email</a></p>`,
  });
  if (delivery.sent) return NextResponse.json({ message: "Workspace created. Check your email to verify the account.", emailDelivery: "sent" });
  if (process.env.NODE_ENV === "production") return NextResponse.json({ message: "Workspace created. Email delivery is not configured yet; ask an administrator to configure the email provider.", emailDelivery: delivery.configured ? "failed" : "misconfigured" });
  return NextResponse.json({ message: "Workspace created. In local development, use the verification link below.", verificationUrl: `/verify?token=${created.verificationToken}`, emailDelivery: "development" });
}
