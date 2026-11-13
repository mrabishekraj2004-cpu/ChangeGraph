import { NextResponse } from "next/server";
import { seedIfNeeded } from "@/lib/db";
import { identityRepository } from "@/lib/identity-repository";
import { mutationGuard, sensitiveAuthRateLimit } from "@/lib/security";
import { sendTransactionalEmail } from "@/lib/email";

export async function POST(request: Request) {
  const blocked = mutationGuard(request, "auth:forgot", sensitiveAuthRateLimit);
  if (blocked) return blocked;
  seedIfNeeded();
  let body: { email?: string };
  try {
    body = await request.json() as { email?: string };
  } catch {
    return NextResponse.json({ message: "If an account exists, a reset link has been created." });
  }
  const { email } = body;
  const user = email ? await identityRepository.getUserByEmail(email) : undefined;
  if (!user) return NextResponse.json({ message: "If an account exists, a reset link has been created." });
  const token = await identityRepository.createEmailToken(user.id, "reset");
  const baseUrl = process.env.APP_URL?.trim() || new URL(request.url).origin;
  const resetUrl = new URL(`/reset-password?token=${token}`, baseUrl).toString();
  const delivery = await sendTransactionalEmail({
    to: user.email,
    subject: "Reset your ChangeGraph password",
    text: `Open this link to reset your ChangeGraph password: ${resetUrl}`,
    html: `<p>Open this link to reset your ChangeGraph password:</p><p><a href="${resetUrl}">Reset password</a></p>`,
  });
  if (process.env.NODE_ENV === "production") return NextResponse.json({ message: "If an account exists, a reset link has been created.", emailDelivery: delivery.sent ? "sent" : delivery.configured ? "failed" : "misconfigured" });
  return NextResponse.json({ message: "In local development, use the reset link below.", resetUrl: `/reset-password?token=${token}` });
}
