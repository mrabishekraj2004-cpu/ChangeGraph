"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";
import { Activity, AlertTriangle, Boxes, ChevronDown, CircleHelp, GitBranch, LayoutDashboard, LoaderCircle, LogOut, Network, Settings, ShieldCheck, SlidersHorizontal } from "lucide-react";
import { initials } from "@/lib/format";

type User = { name: string; email: string; role: string; workspace: { id: string; name: string; mode: string }; workspaces: Array<{ id: string; name: string; slug: string; mode: string; role: string }> };

const nav = [
  { href: "/overview", label: "Overview", icon: LayoutDashboard },
  { href: "/incidents", label: "Incidents", icon: AlertTriangle },
  { href: "/services", label: "Services", icon: Boxes },
  { href: "/changes", label: "Changes", icon: GitBranch },
  { href: "/integrations", label: "Integrations", icon: Network },
  { href: "/evaluations", label: "Evaluations", icon: ShieldCheck },
];

export function AppShell({ user, children }: { user: User; children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const [logoutBusy, setLogoutBusy] = useState(false);
  const [switchBusy, setSwitchBusy] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [switchError, setSwitchError] = useState("");
  const [logoutError, setLogoutError] = useState("");
  const [isRefreshing, startRefresh] = useTransition();
  const helpButtonRef = useRef<HTMLButtonElement>(null);
  const helpDialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!helpOpen) return;
    helpDialogRef.current?.focus();
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        setHelpOpen(false);
        helpButtonRef.current?.focus();
      }
    }
    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [helpOpen]);

  async function logout() {
    setLogoutBusy(true);
    setLogoutError("");
    try {
      const response = await fetch("/api/auth/logout", { method: "POST" });
      if (!response.ok) throw new Error("logout failed");
      router.push("/login");
      router.refresh();
    } catch {
      setLogoutError("We could not sign you out. Check your connection and try again.");
    } finally {
      setLogoutBusy(false);
    }
  }

  async function switchWorkspace(workspaceId: string) {
    setSwitchError("");
    setSwitchBusy(true);
    try {
      const response = await fetch("/api/workspaces/switch", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ workspaceId }) });
      if (!response.ok) throw new Error("workspace switch failed");
      startRefresh(() => router.refresh());
    } catch {
      setSwitchError("Could not switch workspace. Your current workspace is unchanged.");
    } finally {
      setSwitchBusy(false);
    }
  }

  const workspaceBusy = switchBusy || isRefreshing;
  const demoWorkspace = user.workspace.mode === "demo";

  return <div className="app-shell">
    <a className="skip-link" href="#main-content">Skip to main content</a>
    <aside className="sidebar">
      <div className="brand"><div className="brand-mark" aria-hidden="true" /><div><div className="brand-name">ChangeGraph</div><div className="brand-sub">incident intelligence</div></div></div>
      <nav aria-label="Primary navigation">
        <div className="nav-section">Workspace</div>
        {nav.map((item) => {
          const Icon = item.icon;
          const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
          return <Link key={item.href} href={item.href} className={`nav-item ${active ? "active" : ""}`} aria-current={active ? "page" : undefined}><Icon aria-hidden="true" /><span>{item.label}</span></Link>;
        })}
        <div className="nav-section">Control plane</div>
        <Link href="/settings" className={`nav-item ${pathname.startsWith("/settings") ? "active" : ""}`} aria-current={pathname.startsWith("/settings") ? "page" : undefined}><Settings aria-hidden="true" /><span>Settings</span></Link>
      </nav>
      <div className="sidebar-bottom">
        <div className="demo-card"><div className="eyebrow">{demoWorkspace ? "Local demo mode" : "Production workspace"}</div><p>{demoWorkspace ? "Seeded incident data is clearly marked and safe to replay." : "Live source data is scoped to this workspace and its configured integrations."}</p><Link className="panel-link" href="/integrations">Review data sources →</Link></div>
        <div className="user-mini"><div className="avatar" aria-hidden="true">{initials(user.name)}</div><div className="user-mini-copy"><div className="user-mini-name">{user.name}</div><div className="user-mini-role">{user.role}</div></div><button type="button" className="button ghost small" onClick={logout} disabled={logoutBusy} aria-busy={logoutBusy} aria-label="Log out">{logoutBusy ? <LoaderCircle className="spin" aria-hidden="true" /> : <LogOut aria-hidden="true" />}</button></div>
      </div>
    </aside>
    <div className="main-shell">
      <header className="topbar">
        <div className="breadcrumb"><Activity size={14} color="var(--cyan)" aria-hidden="true" /><span>Workspace</span><span aria-hidden="true">/</span><strong>{pathname.split("/")[1] || "overview"}</strong></div>
        <div className="top-actions"><div className="workspace-switcher" aria-busy={workspaceBusy}><Network size={13} aria-hidden="true" /><select aria-label="Switch workspace" value={user.workspace.id} onChange={(event) => switchWorkspace(event.target.value)} disabled={workspaceBusy}>{user.workspaces.map((workspace) => <option key={workspace.id} value={workspace.id}>{workspace.name} · {workspace.role}</option>)}</select><ChevronDown size={13} aria-hidden="true" /></div><button ref={helpButtonRef} type="button" className="button ghost small" onClick={() => setHelpOpen((value) => !value)} aria-expanded={helpOpen} aria-controls="help-popover"><CircleHelp size={14} aria-hidden="true" /> Help</button><Link className="button ghost small" href="/settings"><SlidersHorizontal size={14} aria-hidden="true" /> Settings</Link></div>
      </header>
      {(switchError || logoutError) && <div className="auth-error" role="alert" aria-live="assertive" style={{ position: "fixed", right: 30, top: 72, zIndex: 19 }}>{switchError || logoutError}</div>}
      {helpOpen && <div ref={helpDialogRef} id="help-popover" role="dialog" aria-modal="false" aria-label="Investigation guardrails" tabIndex={-1} style={{ position: "fixed", right: 30, top: 57, zIndex: 20, width: 260 }} className="panel panel-body"><div className="eyebrow">Investigation guardrails</div><p className="muted" style={{ fontSize: 11, margin: "7px 0 0" }}>ChangeGraph links evidence and ranks hypotheses. It does not prove causality from temporal correlation alone.</p><button type="button" className="button ghost small" style={{ marginTop: 12 }} onClick={() => { setHelpOpen(false); helpButtonRef.current?.focus(); }}>Close</button></div>}
      <main id="main-content">{children}</main>
    </div>
  </div>;
}
