import Link from "next/link";
import { CheckCircle2, History, KeyRound, LockKeyhole, Network, UserRound } from "lucide-react";
import { requireUser } from "@/lib/auth";
import { identityRepository } from "@/lib/identity-repository";
import { formatDate } from "@/lib/format";
import { MemberManager, ProfileSettingsForm, WorkspaceCreator, WorkspaceSettingsForm } from "@/components/settings-forms";

export default async function SettingsPage() {
  const user = await requireUser();
  const [members, auditEvents] = await Promise.all([
    identityRepository.listWorkspaceMembers(user.workspace.id),
    identityRepository.listAuditEvents(user.workspace.id),
  ]);
  const canEditWorkspace = ["owner", "admin"].includes(user.role);

  return (
    <div className="content">
      <div className="page-heading">
        <div>
          <div className="eyebrow">Control plane</div>
          <h1>Settings</h1>
          <p>Workspace identity, access, and safety defaults.</p>
        </div>
      </div>
      <div className="settings-grid">
        <div className="panel settings-nav">
          <Link className="active" href="/settings">Workspace profile</Link>
          <Link href="/settings/integrations">Integration policy</Link>
        </div>
        <div className="stack">
          <section className="panel">
            <div className="panel-header"><div><h2>Account profile</h2><p>Identity used in the workspace and incident history</p></div><span className="badge green">{user.verifiedAt ? "verified" : "unverified"}</span></div>
            <div className="panel-body"><ProfileSettingsForm name={user.name} email={user.email} /></div>
          </section>
          <section className="panel">
            <div className="panel-header"><div><h2>Workspace profile</h2><p>Current account and authorization context</p></div><span className="badge amber">{user.role}</span></div>
            <div className="panel-body"><WorkspaceSettingsForm name={user.workspace.name} mode={user.workspace.mode} canEdit={canEditWorkspace} /></div>
          </section>
          <section className="panel">
            <div className="panel-header"><div><h2>Members and roles</h2><p>Server-enforced workspace membership</p></div><span className="badge blue">{members.length} members</span></div>
            <div className="panel-body"><MemberManager members={members} canEdit={canEditWorkspace} /></div>
          </section>
          <section className="panel">
            <div className="panel-header"><div><h2>Audit trail</h2><p>Recent security and workspace actions</p></div><History size={15} color="var(--cyan)" aria-hidden="true" /></div>
            {auditEvents.length ? <div className="list">{auditEvents.map((event) => <div className="list-row" key={event.id}><div className="evidence-kind-icon"><History size={14} aria-hidden="true" /></div><div className="list-main"><div className="list-title">{event.action.replaceAll(".", " · ")}</div><div className="list-sub">{event.actor_name || "System"}{event.entity_id ? ` · ${event.entity_type} ${event.entity_id}` : ""}</div></div><div className="list-end">{formatDate(event.created_at)}</div></div>)}</div> : <div className="empty compact"><History size={20} aria-hidden="true" /><p>No audit events recorded yet.</p></div>}
          </section>
          <section className="panel">
            <div className="panel-header"><div><h2>Create another workspace</h2><p>New workspaces start with you as owner and switch immediately</p></div><Network size={15} color="var(--cyan)" /></div>
            <div className="panel-body"><WorkspaceCreator /></div>
          </section>
          <section className="panel">
            <div className="panel-header"><div><h2>Access model</h2><p>What the server enforces for this session</p></div><LockKeyhole size={15} color="var(--cyan)" /></div>
            <div className="panel-body"><div className="three-column"><div><UserRound size={16} color="var(--cyan)" /><div style={{ marginTop: 9, fontWeight: 650, fontSize: 12 }}>Role-based membership</div><div className="muted" style={{ fontSize: 11, marginTop: 4 }}>Owner, admin, responder, and member roles are checked on writes.</div></div><div><KeyRound size={16} color="var(--amber)" /><div style={{ marginTop: 9, fontWeight: 650, fontSize: 12 }}>Session safety</div><div className="muted" style={{ fontSize: 11, marginTop: 4 }}>HttpOnly, signed, expiring sessions with server-side revocation.</div></div><div><CheckCircle2 size={16} color="var(--green)" /><div style={{ marginTop: 9, fontWeight: 650, fontSize: 12 }}>Email verified</div><div className="muted" style={{ fontSize: 11, marginTop: 4 }}>{user.verifiedAt ? "This account is verified." : "Verification is still required."}</div></div></div></div>
          </section>
        </div>
      </div>
    </div>
  );
}
