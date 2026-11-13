# Vercel deployment readiness

**Status: blocked for a functional Vercel deployment.** A Vercel project named `changegraph` has been created, but it has no deployment or public application URL. The supported deployment today is the single-host Docker setup with a durable SQLite volume and a separate event worker; see [OPERATIONS.md](OPERATIONS.md).

## Actual blocker

The web app and `npm run worker:events` still read and write `better-sqlite3` through `CHANGEGRAPH_DB_PATH`. The first request can create and seed that file. Vercel Functions do not provide the shared, durable application volume that this design requires, and the continuously running worker is not started by deploying the Next.js app. A successful build or a responding landing page would therefore not prove durable accounts, sessions, incidents, event processing, or recovery. Do not point a production Vercel project at this runtime or present a preview as a working live service.

`DATABASE_URL` currently drives only the opt-in PostgreSQL migration/repository check (`npm run test:postgres`). It does **not** select PostgreSQL for the web app or worker. The PostgreSQL schema, identity repository, and event-store primitive are partial migration work; product domain queries, event handlers, detection, evaluation, rate limits, and demo seeding still use SQLite. Adding a hosted Postgres database or setting `DATABASE_URL` alone does not remove the blocker. See [POSTGRES_MIGRATION.md](POSTGRES_MIGRATION.md) for the remaining work and rollout phases.

Before a Vercel release, complete and test the runtime PostgreSQL repository switch for all product paths; move event processing to a durable, scheduled or externally hosted worker design; move rate limiting to shared storage; and verify migrations, workspace isolation, ingestion, retries, and auth against the deployed architecture. Preserve a way to back up and restore the production data. Vercel [Functions](https://vercel.com/docs/functions) have bounded invocations, and [Marketplace storage](https://vercel.com/docs/marketplace-storage) can supply external Postgres once the app actually uses it.

## Configuration inventory for a future deployment

These are application settings, **not** instructions to set them on Vercel today. Configure secrets in the intended Vercel environment, never in source control. [Vercel environment variables](https://vercel.com/docs/environment-variables) are scoped by environment and changes apply to new deployments.

| Variable | When required | Purpose / boundary |
| --- | --- | --- |
| `AUTH_SECRET` | Every functional deployment | Random secret of at least 32 characters for signed sessions. Never use the example value. |
| `APP_URL` | Public deployment | Canonical HTTPS origin for email links and origin checks. Use the actual environment URL. |
| `DATABASE_URL` | **After** the runtime PostgreSQL migration | External Postgres connection. Today it is only for the opt-in migration check; it does not replace SQLite. Use separate databases or schemas for preview and production. |
| `CHANGEGRAPH_DB_PATH` | Current single-host mode only | Path to the durable SQLite file. Setting a path on Vercel cannot make this mode safe. |
| `EMAIL_PROVIDER=resend`, `EMAIL_FROM`, `RESEND_API_KEY` | If real users need verification or password reset | The current mail adapter requires all three to send via Resend. Without delivery, production does not expose one-time links and reports delivery as unconfigured or failed. |
| `CHANGEGRAPH_INGEST_TOKEN`, `CHANGEGRAPH_INGEST_WORKSPACE_ID` | If OTLP ingestion or token-based event processing is enabled | A private token and its target workspace. Keep them paired. |
| `GITHUB_WEBHOOK_SECRET`, `GITHUB_WORKSPACE_ID` | If GitHub webhooks are enabled | Verify webhook signatures and scope accepted events. |
| `AI_MODEL`, `AI_GATEWAY_API_KEY` | Optional model investigator | Both are needed for model-backed runs. Otherwise it abstains; deterministic baseline investigation remains available. |
| `CHANGEGRAPH_METRICS_TOKEN` | Optional external metrics scraper | Dedicated token for `/api/metrics`; the ingest token is accepted as a fallback in the current single-host code. |
| `CHANGEGRAPH_TRUSTED_PROXY_HOPS` | If using trusted forwarding headers | Set only after verifying the actual proxy chain; `0` ignores forwarded client addresses. A shared rate limiter is still needed for multiple instances. |

`CHANGEGRAPH_SEED_DEMO=true` explicitly enables sample data in production mode and must not be mistaken for live provider data. Worker interval, batch, lease, retry, and stale-heartbeat settings in `.env.example` tune the current standalone worker; they do not cause Vercel to run it. The `CHANGEGRAPH_POSTGRES_*` variables in `.env.example` configure the optional local Compose database, not Vercel. Vercel CLI/CI credentials are separate deployment credentials, not application runtime variables.

## Evidence required before calling it live

Run the repository checks (`npm run verify` and the isolated `npm run test:postgres`), then validate the migrated app with a real external database and worker. Confirm registration, verification, login, workspace isolation, incident writes, ingestion, retries/dead letters, worker heartbeat, backup/restore, and restart persistence in the intended environment. Inspect `/api/health` and `/api/metrics`, but do not treat an HTTP 200 or a seeded demo incident as proof of connected integrations or durable processing. Integration status must reflect verified processed events; seeded rows remain `demo-only`.

This document creates no environment variables, database, or deployment. See Vercel's official [deployment documentation](https://vercel.com/docs/deployments), [environment variable guide](https://vercel.com/docs/environment-variables), and [Postgres integration guide](https://vercel.com/docs/postgres) when the migration is ready.
