"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { FormEvent, useState } from "react";
import { ArrowRight, CheckCircle2, GitCommitHorizontal, Network, RadioTower } from "lucide-react";

type AuthMode = "login" | "register" | "forgot" | "reset";

export function AuthFrame({ mode, token }: { mode: AuthMode; token?: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [actionLink, setActionLink] = useState<{ href: string; label: string } | null>(null);

  const copy = {
    login: { title: "Welcome back", lead: "Trace the signal. Test the hypothesis. Leave a cleaner trail.", action: "Sign in" },
    register: { title: "Create your workspace", lead: "Start with a safe local workspace and add live sources when you’re ready.", action: "Create workspace" },
    forgot: { title: "Reset your password", lead: "We’ll create a short-lived reset link for your account.", action: "Create reset link" },
    reset: { title: "Choose a new password", lead: "Use at least 8 characters. Your other sessions will remain signed out.", action: "Update password" },
  }[mode];

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true); setError(""); setSuccess(""); setActionLink(null);
    const body = Object.fromEntries(new FormData(event.currentTarget).entries());
    if (token) body.token = token;
    try {
      const response = await fetch(`/api/auth/${mode}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) { setError(data.error || "Something went wrong. Please try again."); return; }
      if (data.redirect) { router.push(data.redirect); router.refresh(); return; }
      setSuccess(data.message || "Done.");
      if (data.verificationUrl) setActionLink({ href: data.verificationUrl, label: "Open verification link" });
      if (data.resetUrl) setActionLink({ href: data.resetUrl, label: "Open reset link" });
    } catch {
      setError("We could not reach ChangeGraph. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth-screen">
      <div className="auth-layout">
        <section className="auth-story">
          <div className="brand"><div className="brand-mark" aria-hidden="true" /><div><div className="brand-name">ChangeGraph</div><div className="brand-sub">incident intelligence</div></div></div>
          <h1>Incident context that keeps its receipts.</h1>
          <p>Connect the health signal to the change, dependency, deployment, and runbook trail—then show exactly where the evidence stops.</p>
          <div className="signal-list"><div><CheckCircle2 /><span>Evidence-linked investigation timelines</span></div><div><GitCommitHorizontal /><span>Change and deployment correlation</span></div><div><RadioTower /><span>Uncertainty-aware agent outputs</span></div><div><Network /><span>Workspace-scoped access controls</span></div></div>
        </section>
        <section className="auth-card">
          <h2>{copy.title}</h2><p className="lead">{copy.lead}</p>
          <form className="auth-form" onSubmit={submit}>
            {error && <div className="auth-error" role="alert">{error}</div>}
            {success && <div className="auth-success" role="status">{success}{actionLink && <><br /><Link href={actionLink.href}>{actionLink.label} <ArrowRight size={12} style={{ verticalAlign: "-2px" }} /></Link></>}</div>}
            {mode === "register" && <label className="form-field"><span className="form-label">Your name</span><input className="input" name="name" autoComplete="name" placeholder="Alex Morgan" required /></label>}
            {mode !== "reset" && <label className="form-field"><span className="form-label">Email</span><input className="input" name="email" type="email" autoComplete="email" placeholder="you@company.com" required /></label>}
            {mode === "reset" && <label className="form-field"><span className="form-label">New password</span><input className="input" name="password" type="password" autoComplete="new-password" placeholder="••••••••" minLength={8} required /></label>}
            {(mode === "login" || mode === "register") && <label className="form-field"><span className="form-label">Password</span><input className="input" name="password" type="password" autoComplete={mode === "login" ? "current-password" : "new-password"} placeholder="••••••••" minLength={8} required /></label>}
            <button className="button primary" type="submit" disabled={busy}>{busy ? "Working…" : copy.action}<ArrowRight /></button>
          </form>
          <div className="auth-foot">
            {mode === "login" && <><div>New to ChangeGraph? <Link href="/register">Create a workspace</Link></div><div style={{ marginTop: 7 }}><Link href="/forgot-password">Forgot your password?</Link></div></>}
            {mode === "register" && <div>Already have a workspace? <Link href="/login">Sign in</Link></div>}
            {mode === "forgot" && <div>Remembered it? <Link href="/login">Back to sign in</Link></div>}
            {mode === "reset" && <div><Link href="/login">Back to sign in</Link></div>}
          </div>
        </section>
      </div>
    </div>
  );
}
