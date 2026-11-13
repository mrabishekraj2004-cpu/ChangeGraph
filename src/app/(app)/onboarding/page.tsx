import Link from "next/link";
import { ArrowRight, CheckCircle2, Network, ShieldCheck } from "lucide-react";
import { requireUser } from "@/lib/auth";
import { WorkspaceSettingsForm } from "@/components/settings-forms";

export default async function OnboardingPage() {
  const user = await requireUser();
  return <div className="content" style={{ maxWidth: 880 }}><div className="page-heading"><div><div className="eyebrow">Workspace setup</div><h1>Give your workspace a name.</h1><p>Start with the boundary your team will recognize. You can connect sources and invite collaborators from Settings when you are ready.</p></div></div><div className="two-column"><section className="panel"><div className="panel-header"><div><h2>Workspace identity</h2><p>Saved to your workspace record</p></div><Network size={16} color="var(--cyan)" /></div><div className="panel-body"><WorkspaceSettingsForm name={user.workspace.name} mode={user.workspace.mode} canEdit={user.role === "owner" || user.role === "admin"} /></div></section><section className="panel"><div className="panel-header"><div><h2>Foundation ready</h2><p>Your access boundary is already active</p></div><ShieldCheck size={16} color="var(--green)" /></div><div className="panel-body"><div className="guardrail-list" style={{ marginTop: 0 }}><div><span className="check-circle"><CheckCircle2 size={12} /></span><span>Owner membership created</span></div><div><span className="check-circle"><CheckCircle2 size={12} /></span><span>Signed session established</span></div><div><span className="check-circle"><CheckCircle2 size={12} /></span><span>Protected routes enabled</span></div></div><Link href="/overview" className="button primary" style={{ marginTop: 22 }}>Continue to overview <ArrowRight /></Link></div></section></div></div>;
}
