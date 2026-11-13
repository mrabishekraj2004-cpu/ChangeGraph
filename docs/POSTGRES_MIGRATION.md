# PostgreSQL migration boundary

ChangeGraph currently uses `better-sqlite3` deliberately so the portfolio demo can run with one command and no external service. The container deployment persists the database on a durable volume and is suitable for a single application host. This document records the production migration boundary; it is not a claim that PostgreSQL is already supported. CI and the optional Compose service pin PostgreSQL 18.7, the PostgreSQL project's current supported 18.x minor as of this update ([version policy](https://www.postgresql.org/support/versioning/), [18.7 release notes](https://www.postgresql.org/docs/release/18.7/)).

## Why this is a real migration

The current data layer is synchronous and SQLite-specific. It uses positional `?` parameters, WAL/foreign-key pragmas, `INSERT OR IGNORE`, SQLite date functions, `GROUP_CONCAT`, `PRAGMA table_info`, and a process-global database handle. A connection-string-only change would create false confidence and could corrupt authorization or event-processing behavior.

## Current implementation status

The identity/workspace slice now exposes async repository calls for user lookup/creation, workspace lookup and creation, memberships and role changes, sessions, verification/reset tokens, password/profile changes, and workspace-scoped audit reads/writes. Auth and workspace consumers await this contract; a lazily loaded SQLite adapter currently implements it. Membership changes keep the workspace owner invariant, and automated checks cover workspace isolation plus local registration, verification, login, reset, session-revocation, and logout paths.

Two ordered PostgreSQL migrations now exist alongside this migration seam. Migration 1 creates users, workspaces, memberships, sessions, verification/reset tokens, and audit events. Migration 2 adds services, dependencies, changes, deployments, incidents, timelines, telemetry references, hypotheses/evidence, integrations, the event inbox/retry/dead-letter tables, health baselines/anomalies, runbooks, agent/tool-call provenance, evaluations, worker heartbeats, and rate-limit buckets. Workspace-aware composite foreign keys prevent cross-workspace service/deployment/dependency/session relationships at the database boundary. Optional incident/service references use PostgreSQL 18's column-specific `ON DELETE SET NULL` behavior so the workspace key stays intact ([CREATE TABLE reference](https://www.postgresql.org/docs/18/sql-createtable.html)). The migration runner uses a transaction-scoped advisory lock and records applied versions. The integration check runs on PostgreSQL 18, repeats migrations to verify idempotence, and checks representative cross-workspace constraints. It creates a uniquely named temporary schema and drops only that schema when it exits.

The PostgreSQL event-store primitive now supports workspace-scoped idempotent acceptance, concurrent `SKIP LOCKED` claims, lease fencing, retry scheduling, dead-letter persistence, and replay. The integration check exercises those behaviors, including a stale worker losing its lease. Event handlers that write service/change/deployment/telemetry domain records still run through the SQLite processor; the PostgreSQL queue is not selected by the web app or worker yet.

This is not yet a PostgreSQL-backed application. Runtime selection remains on the SQLite adapter. Demo seeding still calls SQLite directly, and domain reads/writes for services, incidents, deployments, detection, integration status, event payload handling, rate limits, and evaluations still issue SQLite-specific statements. Do not configure `DATABASE_URL` for the web app and assume it has switched databases; it is currently used only by the opt-in PostgreSQL repository checks. The app remains single-host until the remaining repositories and migrations move together.

## Target design

1. Introduce a repository interface for auth, workspace authorization, domain reads/writes, ingestion, detection, and evaluations.
2. Implement asynchronous PostgreSQL repositories for the domain tables; the schema, tenant constraints, and event queue primitive are in place, but the product domain methods and event-handler wiring are not yet implemented.
3. Keep every repository method workspace-scoped by construction. No route should receive a raw database handle.
4. Replace SQLite migrations with an ordered PostgreSQL migration set and a CI migration check against an ephemeral database.
5. Use PostgreSQL advisory locks or a durable queue lease for event claims; preserve the current idempotency key and dead-letter contracts.
6. Move telemetry payloads and high-cardinality signal history to ClickHouse or an equivalent retention-aware store. Keep product metadata and provenance in PostgreSQL.
7. Run authorization, migration, idempotency, retry, and cross-workspace tests against PostgreSQL before enabling multi-instance deployment.

## Rollout plan

- Phase A: freeze route contracts and add repository-level characterization tests around the current SQLite implementation.
- Phase B (identity/workspace foundation): implemented as an opt-in PostgreSQL repository and CI integration check. It is not selected by the app runtime.
- Phase C (domain schema and tenant constraints): implemented as a versioned PostgreSQL migration. Domain repositories and runtime selection remain outstanding.
- Phase D: wire the tested event queue into ingestion/worker routes, implement PostgreSQL domain upserts and integration status, then add transactional parity checks.
- Phase E: switch detection, investigations, and evaluations to repositories; compare seeded replay output between engines.
- Phase F: deploy a canary with read-only comparison, then make PostgreSQL the source of truth and retain SQLite only for local demo mode.

## Validate the PostgreSQL migration slice locally

The application does not need PostgreSQL to run. To validate the migration slice with the optional Compose service, generate a temporary local password and start the isolated database:

```powershell
$env:CHANGEGRAPH_POSTGRES_PASSWORD = [guid]::NewGuid().ToString("N") + [guid]::NewGuid().ToString("N")
$env:DATABASE_URL = "postgresql://changegraph:$($env:CHANGEGRAPH_POSTGRES_PASSWORD)@localhost:55432/changegraph"
docker compose --profile postgres up -d postgres
npm run test:postgres
docker compose --profile postgres stop postgres
```

The check creates a uniquely named temporary schema and removes that schema on exit; it does not drop the default `changegraph` schema or tables. For safety, point it only at a disposable PostgreSQL database. Keep these shell values out of source control.

## Deployment gate

Do not run multiple ChangeGraph web or worker instances against the SQLite file. Use the current single-host Docker path for the demo, or complete this migration before using a serverless or horizontally scaled deployment. The health endpoint exposes the migration version and worker heartbeat, but it intentionally does not label SQLite as multi-instance safe.
