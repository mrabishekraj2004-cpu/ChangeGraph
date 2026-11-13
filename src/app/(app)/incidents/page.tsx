import Link from "next/link";
import { ArrowUpRight, ChevronLeft, ChevronRight, Filter, Plus, Search, TriangleAlert } from "lucide-react";
import { requireUser } from "@/lib/auth";
import { queryIncidents } from "@/lib/db";
import { relativeTime } from "@/lib/format";

type SearchParams = Promise<{ q?: string; status?: string; severity?: string; page?: string }>;

function valueOf(value: string | undefined) { return value?.trim() ?? ""; }
function pageHref(search: string, status: string, severity: string, page: number) {
  const params = new URLSearchParams();
  if (search) params.set("q", search);
  if (status && status !== "all") params.set("status", status);
  if (severity && severity !== "all") params.set("severity", severity);
  if (page > 1) params.set("page", String(page));
  const query = params.toString();
  return `/incidents${query ? `?${query}` : ""}`;
}

export default async function IncidentsPage({ searchParams }: { searchParams?: SearchParams }) {
  const user = await requireUser();
  const params = searchParams ? await searchParams : {};
  const search = valueOf(params.q);
  const status = valueOf(params.status) || "all";
  const severity = valueOf(params.severity) || "all";
  const page = Number.isFinite(Number(params.page)) ? Math.max(1, Number(params.page)) : 1;
  const result = queryIncidents(user.workspace.id, { query: search, status, severity, page, pageSize: 8 });
  const hasFilters = Boolean(search || status !== "all" || severity !== "all");
  return <div className="content">
    <div className="page-heading"><div><div className="eyebrow">Investigations</div><h1>Incidents</h1><p>Move from the first health signal to a reviewable, evidence-linked incident record.</p></div><Link href="/incidents/new" className="button primary"><Plus size={14} aria-hidden="true" /> Open incident</Link></div>
    <section className="panel filter-panel" aria-labelledby="incident-filters-title">
      <div className="panel-header"><div><h2 id="incident-filters-title"><Filter size={14} style={{ verticalAlign: "-2px", marginRight: 6 }} aria-hidden="true" /> Find incidents</h2><p>Search the current workspace; filters are applied on the server.</p></div><span className="faint mono">{result.total} records</span></div>
      <form className="filter-bar" method="get">
        <label className="search-field"><Search size={15} aria-hidden="true" /><span className="sr-only">Search incidents</span><input className="input" name="q" defaultValue={search} placeholder="Key, service, symptom…" /></label>
        <label className="compact-field"><span className="form-label">Status</span><select className="select" name="status" defaultValue={status}><option value="all">All statuses</option><option value="investigating">Investigating</option><option value="resolved">Resolved</option><option value="closed">Closed</option></select></label>
        <label className="compact-field"><span className="form-label">Severity</span><select className="select" name="severity" defaultValue={severity}><option value="all">All severities</option><option value="SEV-1">SEV-1</option><option value="SEV-2">SEV-2</option><option value="SEV-3">SEV-3</option><option value="SEV-4">SEV-4</option></select></label>
        <button className="button primary" type="submit">Apply filters</button>
        {hasFilters && <Link className="button ghost" href="/incidents">Clear</Link>}
      </form>
    </section>
    <div className="result-summary" role="status"><span>{result.total ? `Showing ${(result.page - 1) * result.pageSize + 1}–${Math.min(result.total, result.page * result.pageSize)} of ${result.total}` : "No matching incidents"}</span>{hasFilters && <span className="badge blue">filtered</span>}</div>
    <div className="incident-list">
      {result.items.length ? result.items.map((incident) => <Link key={incident.id} href={`/incidents/${incident.id}`} className="incident-card"><div className={`severity-bar ${incident.severity === "SEV-1" ? "red" : incident.severity === "SEV-2" ? "amber-bar" : "green"}`} aria-hidden="true" /><div className="incident-copy"><div className="incident-topline"><span className="eyebrow mono">{incident.key}</span><span className={`badge ${incident.status === "resolved" || incident.status === "closed" ? "green" : "amber"}`}>{incident.status}</span></div><div className="incident-title">{incident.title}</div><div className="incident-summary">{incident.summary}</div><div className="incident-meta"><span><TriangleAlert size={12} aria-hidden="true" /> {incident.severity}</span><span>{incident.service_name}</span><span>{relativeTime(incident.detected_at)}</span></div></div><div className="incident-right"><ArrowUpRight size={15} aria-hidden="true" /></div></Link>) : <div className="panel empty"><TriangleAlert size={22} aria-hidden="true" /><h3>{hasFilters ? "No matching incidents" : "No incidents yet"}</h3><p>{hasFilters ? "Try a broader search or clear the filters." : "Open your first incident to start an evidence trail."}</p>{hasFilters && <Link className="button small" href="/incidents">Clear filters</Link>}</div>}
    </div>
    {result.total > 0 && <nav className="pagination" aria-label="Incident pages">{result.page <= 1 ? <span className="button small disabled" aria-disabled="true"><ChevronLeft size={13} aria-hidden="true" /> Previous</span> : <Link className="button small" href={pageHref(search, status, severity, result.page - 1)}><ChevronLeft size={13} aria-hidden="true" /> Previous</Link>}<span className="faint" aria-live="polite">Page {result.page} of {result.pageCount}</span>{result.page >= result.pageCount ? <span className="button small disabled" aria-disabled="true">Next <ChevronRight size={13} aria-hidden="true" /></span> : <Link className="button small" href={pageHref(search, status, severity, result.page + 1)}>Next <ChevronRight size={13} aria-hidden="true" /></Link>}</nav>}
  </div>;
}
