import Link from "next/link";
import { CheckCircle2 } from "lucide-react";
import { seedIfNeeded } from "@/lib/db";
import { identityRepository } from "@/lib/identity-repository";

export const dynamic = "force-dynamic";

export default async function VerifyPage({ searchParams }: { searchParams: Promise<{ token?: string }> }) {
  seedIfNeeded();
  const { token } = await searchParams;
  const match = token ? await identityRepository.consumeEmailToken(token, "verify") : undefined;
  if (match) { await identityRepository.markUserVerified(match.user_id); await identityRepository.markTokenUsed(match.id); }
  return <div className="auth-screen"><div className="auth-card panel" style={{ width: "min(460px, 100%)" }}><div className="brand"><div className="brand-mark" aria-hidden="true" /><div><div className="brand-name">ChangeGraph</div><div className="brand-sub">incident intelligence</div></div></div><div style={{ textAlign: "center", padding: "40px 12px 27px" }}><CheckCircle2 size={38} color={match ? "var(--green)" : "var(--amber)"} /><h2 style={{ marginTop: 16 }}>{match ? "Email verified" : "Link expired"}</h2><p className="muted">{match ? "Your workspace is ready. You can sign in now." : "That verification link is invalid or has already been used."}</p><Link className="button primary" style={{ marginTop: 18 }} href="/login">Continue to sign in</Link></div></div></div>;
}
