import type { Pool } from "pg";
import type { ChangeQuery, IncidentQuery, IncidentRow } from "./db";

type Row = Record<string, unknown>;

function schemaName(value: string) {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(value)) throw new Error("Invalid PostgreSQL schema name.");
  return value;
}

function isoRows<T>(rows: Row[]): T[] {
  return rows.map((row) => Object.fromEntries(Object.entries(row).map(([key, value]) =>
    [key, value instanceof Date ? value.toISOString() : value]))) as T[];
}

function pagination(page?: number, pageSize?: number) {
  const size = Number.isFinite(pageSize) ? Math.min(50, Math.max(1, Math.floor(pageSize!))) : 8;
  const current = Number.isFinite(page) ? Math.max(1, Math.floor(page!)) : 1;
  return { page: current, pageSize: size, offset: (current - 1) * size };
}

type Service = { id: string; name: string; slug: string; owner: string; status: string; health_score: number; last_deploy_at: string | null };
type Change = { id: string; sha: string; title: string; author: string; repository: string; url: string | null; created_at: string; risk_label: string };
type Deployment = { id: string; service_id: string; change_id: string; version: string; environment: string; status: string; started_at: string; completed_at: string | null; url: string | null; service_name: string; sha: string; change_title: string };

/** Async PostgreSQL read counterpart to the domain reads in db.ts. */
export function createPostgresDomainStore(pool: Pool, schemaNameInput = "changegraph") {
  const schema = schemaName(schemaNameInput);
  const services = `${schema}.services`;
  const incidents = `${schema}.incidents`;
  const changes = `${schema}.changes`;
  const deployments = `${schema}.deployments`;

  const listServices = async (workspaceId: string) => isoRows<Service>((await pool.query(
    `SELECT id, name, slug, owner, status, health_score, last_deploy_at FROM ${services} WHERE workspace_id = $1 ORDER BY name, id`, [workspaceId])).rows);

  const listIncidents = async (workspaceId: string) => isoRows<IncidentRow>((await pool.query(
    `SELECT i.id, i.key, i.title, i.service_id, s.name AS service_name, i.severity, i.status, i.started_at, i.detected_at, i.summary, i.impact
     FROM ${incidents} i JOIN ${services} s ON s.workspace_id = i.workspace_id AND s.id = i.service_id
     WHERE i.workspace_id = $1 ORDER BY i.detected_at DESC, i.id DESC`, [workspaceId])).rows);

  const listChanges = async (workspaceId: string) => isoRows<Change>((await pool.query(
    `SELECT id, sha, title, author, repository, url, created_at, risk_label FROM ${changes}
     WHERE workspace_id = $1 ORDER BY created_at DESC, id DESC`, [workspaceId])).rows);

  const listDeployments = async (workspaceId: string) => isoRows<Deployment>((await pool.query(
    `SELECT d.id, d.workspace_id, d.service_id, d.change_id, d.version, d.environment, d.status, d.started_at, d.completed_at, d.url,
            s.name AS service_name, c.sha, c.title AS change_title
     FROM ${deployments} d JOIN ${services} s ON s.workspace_id = d.workspace_id AND s.id = d.service_id
     JOIN ${changes} c ON c.workspace_id = d.workspace_id AND c.id = d.change_id
     WHERE d.workspace_id = $1 ORDER BY d.started_at DESC, d.id DESC`, [workspaceId])).rows);

  return {
    listServices,
    listIncidents,
    listChanges,
    listDeployments,

    async getOverview(workspaceId: string) {
      const [incidentRows, serviceRows, changeRows, deploymentRows] = await Promise.all([
        listIncidents(workspaceId), listServices(workspaceId), listChanges(workspaceId), listDeployments(workspaceId),
      ]);
      return { incidents: incidentRows, services: serviceRows, changes: changeRows, deployments: deploymentRows };
    },

    async getIncident(workspaceId: string, incidentId: string) {
      const rows = (await pool.query(
        `SELECT i.id, i.key, i.title, i.service_id, s.name AS service_name, s.owner AS service_owner,
                i.severity, i.status, i.started_at, i.detected_at, i.summary, i.impact
         FROM ${incidents} i JOIN ${services} s ON s.workspace_id = i.workspace_id AND s.id = i.service_id
         WHERE i.workspace_id = $1 AND i.id = $2`, [workspaceId, incidentId])).rows;
      return isoRows<IncidentRow & { service_owner: string }>(rows)[0];
    },

    async getIncidentTimeline(workspaceId: string, incidentId: string) {
      return isoRows((await pool.query(
        `SELECT te.id, te.occurred_at, te.type, te.title, te.description, te.source_url, te.evidence_kind, te.evidence_ref
         FROM ${schema}.timeline_events te JOIN ${incidents} i ON i.workspace_id = te.workspace_id AND i.id = te.incident_id
         WHERE te.workspace_id = $1 AND te.incident_id = $2 ORDER BY te.occurred_at, te.id`, [workspaceId, incidentId])).rows);
    },

    async queryIncidents(workspaceId: string, input: IncidentQuery = {}) {
      const { page, pageSize, offset } = pagination(input.page, input.pageSize);
      const params: unknown[] = [workspaceId];
      const where = ["i.workspace_id = $1"];
      const query = input.query?.trim();
      if (query) {
        params.push(`%${query}%`);
        where.push(`(i.key ILIKE $${params.length} OR i.title ILIKE $${params.length} OR i.summary ILIKE $${params.length} OR i.impact ILIKE $${params.length} OR s.name ILIKE $${params.length})`);
      }
      if (input.status && input.status !== "all") { params.push(input.status); where.push(`i.status = $${params.length}`); }
      if (input.severity && input.severity !== "all") { params.push(input.severity); where.push(`i.severity = $${params.length}`); }
      const from = `FROM ${incidents} i JOIN ${services} s ON s.workspace_id = i.workspace_id AND s.id = i.service_id WHERE ${where.join(" AND ")}`;
      const total = Number((await pool.query(`SELECT COUNT(*)::int AS count ${from}`, params)).rows[0].count);
      const rows = (await pool.query(
        `SELECT i.id, i.key, i.title, i.service_id, s.name AS service_name, i.severity, i.status, i.started_at, i.detected_at, i.summary, i.impact
         ${from} ORDER BY i.detected_at DESC, i.id DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, pageSize, offset])).rows;
      return { items: isoRows<IncidentRow>(rows), total, page, pageSize, pageCount: Math.max(1, Math.ceil(total / pageSize)) };
    },

    async getServiceForWorkspace(workspaceId: string, serviceId: string) {
      const rows = (await pool.query(`SELECT id, name FROM ${services} WHERE workspace_id = $1 AND id = $2`, [workspaceId, serviceId])).rows;
      return rows[0] as { id: string; name: string } | undefined;
    },

    async getServiceDependencies(workspaceId: string) {
      return (await pool.query(
        `SELECT sd.upstream_service_id, sd.downstream_service_id, sd.dependency_kind,
                upstream.name AS upstream_name, upstream.slug AS upstream_slug,
                downstream.name AS downstream_name, downstream.slug AS downstream_slug
         FROM ${schema}.service_dependencies sd
         JOIN ${services} upstream ON upstream.workspace_id = sd.workspace_id AND upstream.id = sd.upstream_service_id
         JOIN ${services} downstream ON downstream.workspace_id = sd.workspace_id AND downstream.id = sd.downstream_service_id
         WHERE sd.workspace_id = $1 ORDER BY downstream.name, upstream.name`, [workspaceId])).rows;
    },

    async listServiceChanges(workspaceId: string, serviceId: string, limit = 8) {
      return isoRows((await pool.query(
        `SELECT d.id AS deployment_id, d.version, d.environment, d.status, d.started_at, d.completed_at, d.url,
                c.id AS change_id, c.sha, c.title, c.author, c.repository, c.url AS change_url, c.risk_label
         FROM ${deployments} d JOIN ${changes} c ON c.workspace_id = d.workspace_id AND c.id = d.change_id
         WHERE d.workspace_id = $1 AND d.service_id = $2 ORDER BY d.started_at DESC, d.id DESC LIMIT $3`,
        [workspaceId, serviceId, Math.min(30, Math.max(1, Number.isFinite(limit) ? Math.floor(limit) : 8))])).rows);
    },

    async queryChanges(workspaceId: string, input: ChangeQuery = {}) {
      const { page, pageSize, offset } = pagination(input.page, input.pageSize);
      const params: unknown[] = [workspaceId];
      const where = ["c.workspace_id = $1"];
      const query = input.query?.trim();
      if (query) {
        params.push(`%${query}%`);
        where.push(`(c.sha ILIKE $${params.length} OR c.title ILIKE $${params.length} OR c.author ILIKE $${params.length} OR c.repository ILIKE $${params.length} OR s.name ILIKE $${params.length})`);
      }
      if (input.risk && input.risk !== "all") { params.push(input.risk); where.push(`c.risk_label = $${params.length}`); }
      if (input.service && input.service !== "all") { params.push(input.service); where.push(`s.id = $${params.length}`); }
      const from = `FROM ${changes} c LEFT JOIN ${deployments} d ON d.workspace_id = c.workspace_id AND d.change_id = c.id
        LEFT JOIN ${services} s ON s.workspace_id = d.workspace_id AND s.id = d.service_id WHERE ${where.join(" AND ")}`;
      const total = Number((await pool.query(`SELECT COUNT(DISTINCT c.id)::int AS count ${from}`, params)).rows[0].count);
      const rows = (await pool.query(
        `SELECT c.id, c.sha, c.title, c.author, c.repository, c.url, c.created_at, c.risk_label,
                COUNT(DISTINCT d.id)::int AS deployment_count, STRING_AGG(DISTINCT s.name, ',') AS affected_services
         ${from} GROUP BY c.id ORDER BY c.created_at DESC, c.id DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, pageSize, offset])).rows;
      return { items: isoRows<Change & { deployment_count: number; affected_services: string | null }>(rows), total, page, pageSize, pageCount: Math.max(1, Math.ceil(total / pageSize)) };
    },

    async countRecentDeployments(workspaceId: string, hours = 24) {
      const safeHours = Math.min(168, Math.max(1, Number.isFinite(hours) ? hours : 24));
      const row = (await pool.query(
        `SELECT COUNT(*)::int AS count FROM ${deployments} WHERE workspace_id = $1 AND started_at >= NOW() - ($2::double precision * INTERVAL '1 hour')`,
        [workspaceId, safeHours])).rows[0];
      return Number(row.count);
    },
  };
}
