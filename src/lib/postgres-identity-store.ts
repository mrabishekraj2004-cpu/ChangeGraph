import { createHash, randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import { Pool, type PoolClient } from "pg";
import type { IdentityStore } from "./identity-repository";
import { postgresDomainSchemaSql } from "./postgres-domain-schema";

// This schema is intentionally isolated from the SQLite demo. It carries the
// identity, workspace-membership, and audit slice only; the application does
// not select it at runtime until the remaining domain repositories have moved.
const defaultSchema = "changegraph";
const identityMigrationVersion = 1;
const domainMigrationVersion = 2;

function validatedSchemaName(value: string) {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(value)) throw new Error("Invalid PostgreSQL schema name.");
  return value;
}

type Row = Record<string, unknown>;

function nowIso() {
  return new Date().toISOString();
}

function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

function asIso(value: unknown) {
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

function mapWorkspace(row: Row) {
  return {
    id: String(row.id),
    name: String(row.name),
    slug: String(row.slug),
    mode: String(row.mode),
    role: String(row.role),
    created_at: asIso(row.created_at),
  };
}

async function withTransaction<T>(pool: Pool, work: (client: PoolClient) => Promise<T>) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

function identitySchemaSql(schema: string) { return `
  CREATE SCHEMA IF NOT EXISTS ${schema};
  CREATE TABLE IF NOT EXISTS ${schema}.schema_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at TIMESTAMPTZ NOT NULL
  );
  CREATE TABLE IF NOT EXISTS ${schema}.users (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    name TEXT NOT NULL,
    verified_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL
  );
  CREATE TABLE IF NOT EXISTS ${schema}.workspaces (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    slug TEXT NOT NULL UNIQUE,
    mode TEXT NOT NULL DEFAULT 'production',
    created_at TIMESTAMPTZ NOT NULL
  );
  CREATE TABLE IF NOT EXISTS ${schema}.memberships (
    workspace_id TEXT NOT NULL REFERENCES ${schema}.workspaces(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES ${schema}.users(id) ON DELETE CASCADE,
    role TEXT NOT NULL DEFAULT 'member',
    created_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (workspace_id, user_id)
  );
  CREATE TABLE IF NOT EXISTS ${schema}.sessions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES ${schema}.users(id) ON DELETE CASCADE,
    workspace_id TEXT NOT NULL REFERENCES ${schema}.workspaces(id) ON DELETE CASCADE,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL
  );
  CREATE INDEX IF NOT EXISTS sessions_user_idx ON ${schema}.sessions(user_id);
  CREATE TABLE IF NOT EXISTS ${schema}.email_tokens (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES ${schema}.users(id) ON DELETE CASCADE,
    type TEXT NOT NULL,
    token TEXT NOT NULL UNIQUE,
    expires_at TIMESTAMPTZ NOT NULL,
    used_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL
  );
  CREATE INDEX IF NOT EXISTS email_tokens_lookup_idx ON ${schema}.email_tokens(token, type, expires_at);
  CREATE TABLE IF NOT EXISTS ${schema}.audit_events (
    id TEXT PRIMARY KEY,
    workspace_id TEXT REFERENCES ${schema}.workspaces(id) ON DELETE CASCADE,
    actor_user_id TEXT REFERENCES ${schema}.users(id) ON DELETE SET NULL,
    action TEXT NOT NULL,
    entity_type TEXT NOT NULL,
    entity_id TEXT,
    metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL
  );
  CREATE INDEX IF NOT EXISTS audit_events_workspace_idx ON ${schema}.audit_events(workspace_id, created_at DESC);
`; }

export function createPostgresPool(connectionString: string) {
  return new Pool({
    connectionString,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  });
}

export async function runPostgresMigrations(pool: Pool, schemaName = defaultSchema) {
  const schema = validatedSchemaName(schemaName);
  await withTransaction(pool, async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1)::bigint)", [`changegraph-migrations:${schema}`]);
    await client.query(`CREATE SCHEMA IF NOT EXISTS ${schema}`);
    await client.query(`CREATE TABLE IF NOT EXISTS ${schema}.schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TIMESTAMPTZ NOT NULL)`);
    const appliedRows = await client.query<{ version: number }>(`SELECT version FROM ${schema}.schema_migrations`);
    const applied = new Set(appliedRows.rows.map((row) => Number(row.version)));

    if (!applied.has(identityMigrationVersion)) {
      await client.query(identitySchemaSql(schema));
      await client.query(
        `INSERT INTO ${schema}.schema_migrations (version, name, applied_at) VALUES ($1, $2, NOW())`,
        [identityMigrationVersion, "identity-workspace-audit-foundation"],
      );
    }
    if (!applied.has(domainMigrationVersion)) {
      await client.query(postgresDomainSchemaSql(schema));
      await client.query(
        `INSERT INTO ${schema}.schema_migrations (version, name, applied_at) VALUES ($1, $2, NOW())`,
        [domainMigrationVersion, "workspace-scoped-domain-ingestion-agent-evaluation"],
      );
    }
  });
}

export const runPostgresIdentityMigrations = runPostgresMigrations;

export function createPostgresIdentityStore(pool: Pool, schemaName = defaultSchema): IdentityStore {
  const schema = validatedSchemaName(schemaName);
  return {
    async createSession(userId, workspaceId) {
      const id = randomUUID();
      const expiresAt = new Date(Date.now() + 1000 * 60 * 60 * 24 * 14).toISOString();
      await pool.query(
        `INSERT INTO ${schema}.sessions (id, user_id, workspace_id, expires_at, created_at) VALUES ($1, $2, $3, $4, $5)`,
        [id, userId, workspaceId, expiresAt, nowIso()],
      );
      return { id, expiresAt };
    },

    async findSession(id) {
      const result = await pool.query<Row>(
        `SELECT s.id, s.user_id, s.workspace_id, s.expires_at, u.email, u.name, u.verified_at, m.role,
          w.name AS workspace_name, w.slug AS workspace_slug, w.mode AS workspace_mode
         FROM ${schema}.sessions s
         JOIN ${schema}.users u ON u.id = s.user_id
         JOIN ${schema}.memberships m ON m.workspace_id = s.workspace_id AND m.user_id = s.user_id
         JOIN ${schema}.workspaces w ON w.id = s.workspace_id
         WHERE s.id = $1`,
        [id],
      );
      const row = result.rows[0];
      if (!row) return undefined;
      return {
        id: String(row.id), user_id: String(row.user_id), workspace_id: String(row.workspace_id), expires_at: asIso(row.expires_at),
        email: String(row.email), name: String(row.name), verified_at: row.verified_at ? asIso(row.verified_at) : null,
        role: String(row.role), workspace_name: String(row.workspace_name), workspace_slug: String(row.workspace_slug), workspace_mode: String(row.workspace_mode),
      };
    },

    async getUserWorkspaces(userId) {
      const result = await pool.query<Row>(
        `SELECT w.id, w.name, w.slug, w.mode, m.role
         FROM ${schema}.workspaces w JOIN ${schema}.memberships m ON m.workspace_id = w.id
         WHERE m.user_id = $1 ORDER BY w.created_at ASC`,
        [userId],
      );
      return result.rows.map((row) => ({ id: String(row.id), name: String(row.name), slug: String(row.slug), mode: String(row.mode), role: String(row.role) }));
    },

    async removeSession(id) {
      await pool.query(`DELETE FROM ${schema}.sessions WHERE id = $1`, [id]);
    },

    async switchSessionWorkspace(sessionId, userId, workspaceId) {
      const result = await pool.query(
        `UPDATE ${schema}.sessions s SET workspace_id = $1
         WHERE s.id = $2 AND s.user_id = $3
           AND EXISTS (SELECT 1 FROM ${schema}.memberships m WHERE m.workspace_id = $1 AND m.user_id = $3)`,
        [workspaceId, sessionId, userId],
      );
      return (result.rowCount ?? 0) > 0;
    },

    async getUserByEmail(email) {
      const result = await pool.query<Row>(`SELECT id, email, password_hash, name, verified_at FROM ${schema}.users WHERE email = $1`, [email.toLowerCase().trim()]);
      const row = result.rows[0];
      return row ? { id: String(row.id), email: String(row.email), password_hash: String(row.password_hash), name: String(row.name), verified_at: row.verified_at ? asIso(row.verified_at) : null } : undefined;
    },

    async getWorkspaceForUser(userId, workspaceId) {
      const result = await pool.query<Row>(
        workspaceId
          ? `SELECT w.*, m.role FROM ${schema}.workspaces w JOIN ${schema}.memberships m ON m.workspace_id = w.id WHERE w.id = $1 AND m.user_id = $2`
          : `SELECT w.*, m.role FROM ${schema}.workspaces w JOIN ${schema}.memberships m ON m.workspace_id = w.id WHERE m.user_id = $1 ORDER BY w.created_at ASC LIMIT 1`,
        workspaceId ? [workspaceId, userId] : [userId],
      );
      return result.rows[0] ? mapWorkspace(result.rows[0]) : undefined;
    },

    async createUser(input) {
      const id = `usr_${randomUUID().slice(0, 8)}`;
      const workspaceId = `ws_${randomUUID().slice(0, 8)}`;
      const timestamp = nowIso();
      const verificationToken = randomUUID().replaceAll("-", "");
      await withTransaction(pool, async (client) => {
        await client.query(`INSERT INTO ${schema}.users (id, email, password_hash, name, created_at) VALUES ($1, $2, $3, $4, $5)`, [id, input.email.toLowerCase().trim(), bcrypt.hashSync(input.password, 10), input.name.trim(), timestamp]);
        await client.query(`INSERT INTO ${schema}.workspaces (id, name, slug, mode, created_at) VALUES ($1, $2, $3, $4, $5)`, [workspaceId, `${input.name.trim()}'s workspace`, `workspace-${id.slice(-6)}`, "production", timestamp]);
        await client.query(`INSERT INTO ${schema}.memberships (workspace_id, user_id, role, created_at) VALUES ($1, $2, 'owner', $3)`, [workspaceId, id, timestamp]);
        await client.query(`INSERT INTO ${schema}.email_tokens (id, user_id, type, token, expires_at, created_at) VALUES ($1, $2, 'verify', $3, $4, $5)`, [randomUUID(), id, hashToken(verificationToken), new Date(Date.now() + 1000 * 60 * 60 * 24).toISOString(), timestamp]);
      });
      return { id, workspaceId, verificationToken };
    },

    async createEmailToken(userId, type) {
      const token = randomUUID().replaceAll("-", "");
      await pool.query(
        `INSERT INTO ${schema}.email_tokens (id, user_id, type, token, expires_at, created_at) VALUES ($1, $2, $3, $4, $5, $6)`,
        [randomUUID(), userId, type, hashToken(token), new Date(Date.now() + 1000 * 60 * 60).toISOString(), nowIso()],
      );
      return token;
    },

    async consumeEmailToken(token, type) {
      const result = await pool.query<Row>(
        `SELECT id, user_id FROM ${schema}.email_tokens WHERE token = $1 AND type = $2 AND used_at IS NULL AND expires_at > NOW()`,
        [hashToken(token), type],
      );
      const row = result.rows[0];
      return row ? { id: String(row.id), user_id: String(row.user_id) } : undefined;
    },

    async markTokenUsed(id) {
      await pool.query(`UPDATE ${schema}.email_tokens SET used_at = NOW() WHERE id = $1`, [id]);
    },

    async markUserVerified(userId) {
      await pool.query(`UPDATE ${schema}.users SET verified_at = NOW() WHERE id = $1`, [userId]);
    },

    async updatePassword(userId, password) {
      await withTransaction(pool, async (client) => {
        await client.query(`UPDATE ${schema}.users SET password_hash = $1 WHERE id = $2`, [bcrypt.hashSync(password, 10), userId]);
        await client.query(`DELETE FROM ${schema}.sessions WHERE user_id = $1`, [userId]);
      });
    },

    async updateUserName(userId, name) {
      await pool.query(`UPDATE ${schema}.users SET name = $1 WHERE id = $2`, [name.trim(), userId]);
    },

    async recordAuditEvent(input) {
      await pool.query(
        `INSERT INTO ${schema}.audit_events (id, workspace_id, actor_user_id, action, entity_type, entity_id, metadata_json, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)`,
        [`audit_${randomUUID().replaceAll("-", "").slice(0, 18)}`, input.workspaceId ?? null, input.actorUserId ?? null, input.action, input.entityType, input.entityId ?? null, JSON.stringify(input.metadata ?? {}), nowIso()],
      );
    },

    async listWorkspaceMembers(workspaceId) {
      const result = await pool.query<Row>(
        `SELECT u.id, u.name, u.email, u.verified_at, m.role, m.created_at
         FROM ${schema}.memberships m JOIN ${schema}.users u ON u.id = m.user_id
         WHERE m.workspace_id = $1 ORDER BY m.created_at ASC`,
        [workspaceId],
      );
      return result.rows.map((row) => ({ id: String(row.id), name: String(row.name), email: String(row.email), verified_at: row.verified_at ? asIso(row.verified_at) : null, role: String(row.role), created_at: asIso(row.created_at) }));
    },

    async listAuditEvents(workspaceId, limit = 40) {
      const result = await pool.query<Row>(
        `SELECT a.id, a.action, a.entity_type, a.entity_id, a.metadata_json::text, a.created_at, u.name AS actor_name, u.email AS actor_email
         FROM ${schema}.audit_events a LEFT JOIN ${schema}.users u ON u.id = a.actor_user_id
         WHERE a.workspace_id = $1 ORDER BY a.created_at DESC LIMIT $2`,
        [workspaceId, Math.min(100, Math.max(1, limit))],
      );
      return result.rows.map((row) => ({ id: String(row.id), action: String(row.action), entity_type: String(row.entity_type), entity_id: row.entity_id ? String(row.entity_id) : null, metadata_json: String(row.metadata_json), created_at: asIso(row.created_at), actor_name: row.actor_name ? String(row.actor_name) : null, actor_email: row.actor_email ? String(row.actor_email) : null }));
    },

    async addWorkspaceMember(workspaceId, email, role) {
      const user = await pool.query<Row>(`SELECT id FROM ${schema}.users WHERE email = $1`, [email.toLowerCase().trim()]);
      const userId = user.rows[0]?.id;
      if (!userId) return { ok: false as const, reason: "not_found" as const };
      const inserted = await pool.query(
        `INSERT INTO ${schema}.memberships (workspace_id, user_id, role, created_at) VALUES ($1, $2, $3, $4) ON CONFLICT (workspace_id, user_id) DO NOTHING`,
        [workspaceId, String(userId), role, nowIso()],
      );
      if (inserted.rowCount === 0) return { ok: false as const, reason: "exists" as const };
      return { ok: true as const, userId: String(userId) };
    },

    async updateWorkspaceMemberRole(workspaceId, userId, role) {
      return withTransaction(pool, async (client) => {
        const current = await client.query<Row>(`SELECT role FROM ${schema}.memberships WHERE workspace_id = $1 AND user_id = $2 FOR UPDATE`, [workspaceId, userId]);
        if (!current.rows[0] || (current.rows[0].role === "owner" && role !== "owner")) return false;
        if (role === "owner") {
          const owner = await client.query<Row>(`SELECT user_id FROM ${schema}.memberships WHERE workspace_id = $1 AND role = 'owner' FOR UPDATE`, [workspaceId]);
          if (owner.rows[0] && owner.rows[0].user_id !== userId) return false;
        }
        const updated = await client.query(`UPDATE ${schema}.memberships SET role = $1 WHERE workspace_id = $2 AND user_id = $3`, [role, workspaceId, userId]);
        return (updated.rowCount ?? 0) > 0;
      });
    },

    async removeWorkspaceMember(workspaceId, userId) {
      return withTransaction(pool, async (client) => {
        const owner = await client.query<Row>(`SELECT user_id FROM ${schema}.memberships WHERE workspace_id = $1 AND role = 'owner' FOR UPDATE`, [workspaceId]);
        if (owner.rows[0]?.user_id === userId) return false;
        const deleted = await client.query(`DELETE FROM ${schema}.memberships WHERE workspace_id = $1 AND user_id = $2`, [workspaceId, userId]);
        return (deleted.rowCount ?? 0) > 0;
      });
    },

    async updateWorkspace(workspaceId, input) {
      await pool.query(`UPDATE ${schema}.workspaces SET name = $1, mode = $2 WHERE id = $3`, [input.name.trim(), input.mode, workspaceId]);
    },

    async createWorkspace(userId, input) {
      const id = `ws_${randomUUID().slice(0, 8)}`;
      const timestamp = nowIso();
      const slug = `${input.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 36) || "workspace"}-${id.slice(-4)}`;
      await withTransaction(pool, async (client) => {
        await client.query(`INSERT INTO ${schema}.workspaces (id, name, slug, mode, created_at) VALUES ($1, $2, $3, $4, $5)`, [id, input.name.trim(), slug, input.mode, timestamp]);
        await client.query(`INSERT INTO ${schema}.memberships (workspace_id, user_id, role, created_at) VALUES ($1, $2, 'owner', $3)`, [id, userId, timestamp]);
      });
      return { id, slug };
    },
  } satisfies IdentityStore;
}

export const postgresIdentitySchema = defaultSchema;
