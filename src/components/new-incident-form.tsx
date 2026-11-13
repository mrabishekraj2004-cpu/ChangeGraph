"use client";

import { useRouter } from "next/navigation";
import { FormEvent, useState } from "react";
import { ArrowLeft, ArrowRight, CircleAlert } from "lucide-react";
import Link from "next/link";

export function NewIncidentForm({ services }: { services: Array<{ id: string; name: string }> }) {
  const router = useRouter();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError("");
    const body = Object.fromEntries(new FormData(event.currentTarget).entries());
    try {
      const response = await fetch("/api/incidents", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) { setError(data.error || "Could not create the incident."); return; }
      router.push(`/incidents/${data.id}`); router.refresh();
    } catch {
      setError("We could not reach ChangeGraph. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }
  if (!services.length) return <div className="panel empty"><CircleAlert size={24} aria-hidden="true" /><h2>No services available</h2><p>Create or ingest a service before opening an incident. ChangeGraph needs a service context to build the investigation timeline.</p><div className="page-actions" style={{ justifyContent: "center", marginTop: 16 }}><Link className="button primary" href="/integrations">Open integrations</Link><Link className="button ghost" href="/incidents">Back to incidents</Link></div></div>;
  return <form className="panel panel-body" onSubmit={submit}><div className="form-grid"><label className="form-field full"><span className="form-label">Incident title</span><input className="input" name="title" placeholder="Checkout latency spike" required /></label><label className="form-field"><span className="form-label">Affected service</span><select className="select" name="serviceId" defaultValue={services[0].id} required>{services.map((service) => <option value={service.id} key={service.id}>{service.name}</option>)}</select></label><label className="form-field"><span className="form-label">Severity</span><select className="select" name="severity" defaultValue="SEV-3"><option>SEV-1</option><option>SEV-2</option><option>SEV-3</option><option>SEV-4</option></select></label><label className="form-field full"><span className="form-label">What is the user impact?</span><textarea className="textarea" name="impact" placeholder="Describe who is affected and how." required /></label><label className="form-field full"><span className="form-label">Initial summary</span><textarea className="textarea" name="summary" placeholder="What changed in the health signal?" required /></label></div>{error && <div className="auth-error" role="alert" aria-live="assertive" style={{ marginTop: 15 }}>{error}</div>}<div style={{ display: "flex", justifyContent: "space-between", marginTop: 18 }}><Link className="button ghost" href="/incidents"><ArrowLeft /> Cancel</Link><button className="button primary" type="submit" disabled={busy}>{busy ? "Creating…" : "Create incident"}<ArrowRight /></button></div></form>;
}
