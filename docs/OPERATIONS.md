# ChangeGraph operations runbook

This runbook describes the supported single-host deployment mode. It is intentionally explicit: SQLite is durable when its volume is durable, but it is not safe to share the file across multiple web or worker instances.

## Start the application

For local development:

```powershell
Copy-Item .env.example .env.local
# Set AUTH_SECRET to a long random value in .env.local
npm install
npm run dev
```

Run the event worker in a second terminal:

```powershell
npm run worker:events
```

For the container path, use the provided Compose file to run separate non-root web and event-worker images. The worker is bundled at build time and contains only its SQLite runtime dependencies. Both processes must see the same durable `/app/data` volume; back up that volume using the documented backup command before upgrades or host maintenance.

## Check readiness

`GET /api/health` reports database readiness, migration version, storage mode, and worker heartbeat. A healthy database does not mean provider integrations are connected; inspect the Integrations page and the integration status fields separately.

Mutation rate limits use `CHANGEGRAPH_TRUSTED_PROXY_HOPS` to decide whether to trust `X-Forwarded-For`. The default `0` ignores caller-supplied forwarding headers, which keeps spoofed addresses from bypassing a limit but puts direct clients into one shared bucket. When deploying behind a reverse proxy, set the value to the exact number of trusted proxies and configure the edge proxy to append the address it observed. Do not set a positive value when clients can reach the app through an untrusted proxy path.

The current storage contract is:

```json
{
  "provider": "sqlite",
  "deploymentMode": "single_host",
  "multiInstanceSafe": false
}
```

Do not run multiple application or worker instances against the same SQLite file.

## Create a verified backup

Run this while the application is running or stopped; SQLite's backup API creates a consistent snapshot without copying the WAL files manually:

```powershell
npm run backup:db
```

The default destination is `data/backups`. Set `CHANGEGRAPH_BACKUP_DIR` to point to durable backup storage. The command verifies the copied database with `PRAGMA integrity_check` and reports the migration version in its JSON output.

Example:

```powershell
$env:CHANGEGRAPH_BACKUP_DIR = "D:\ChangeGraphBackups"
npm run backup:db
```

Keep backups outside the source repository, encrypt them at rest, restrict access, and apply a retention policy. The repository does not upload backups or contain credentials for backup storage.

## Restore a backup

1. Stop the web process and event worker.
2. Preserve the current database file for investigation.
3. Copy a verified backup to the configured `CHANGEGRAPH_DB_PATH`.
4. Start the worker first, confirm `/api/health`, then start the web process.
5. Review the audit trail and event inbox for the restore point before accepting provider traffic.

Do not overwrite a live database file while the worker is processing events.

## Incident response checks

- Check `/api/health` for database and worker state.
- Check `/api/metrics` for event inbox counts and dead letters.
- Review Integrations for `connected`, `pending`, `misconfigured`, or `demo-only` status.
- Re-run a dead-letter event only after correcting the underlying configuration or payload.
- Treat detector and model outputs as hypotheses with evidence references, never as proof of causality.

## Production boundary

Before horizontally scaling, migrate product state to PostgreSQL, event processing to a durable queue, rate limits to shared infrastructure, and telemetry references to a retention-aware store. See [POSTGRES_MIGRATION.md](POSTGRES_MIGRATION.md).

## Seeded evaluation gate

`npm run eval:gate` creates an isolated in-memory database, seeds the three known-cause/abstention examples, replays the deterministic detector, and exits nonzero if any case fails, top-three accuracy or evidence coverage falls below 100%, abstention accuracy falls below 100%, or average detection lag exceeds two minutes. CI runs this gate on each push and pull request. The thresholds protect the small seeded regression set; they do not measure performance on real production incidents or the optional model-backed agent.
