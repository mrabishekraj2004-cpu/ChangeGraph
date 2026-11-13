# ChangeGraph

ChangeGraph is an evidence-linked incident investigation workspace for platform and SRE teams. It connects health signals to changes, deployments, service dependencies, runbooks, and prior incidents while explicitly preserving uncertainty.

## Run locally

```bash
npm install
copy .env.example .env.local
npm run dev
```

For local development, set non-checked-in values for `AUTH_SECRET`, `CHANGEGRAPH_INGEST_TOKEN`, and `CHANGEGRAPH_INGEST_WORKSPACE_ID` in `.env.local`. Verification and password-reset emails use an explicit development inbox pattern: the API returns a one-time relative link in the success state so you can open it locally without sending credentials or tokens to an external provider. Production can use the optional Resend adapter by setting `EMAIL_PROVIDER=resend`, `EMAIL_FROM`, `RESEND_API_KEY`, and `APP_URL`; otherwise the app reports that email delivery is not configured and does not expose tokens. Never expose or commit `.env.local`.

The deterministic detector and baseline investigator work without model credentials. To enable the optional read-only model investigator, set both `AI_MODEL` to a provider/model identifier supported by the configured AI Gateway and `AI_GATEWAY_API_KEY` in your untracked `.env.local`. When either value is absent, “Run AI agent” records an explicit abstention and does not claim to have called a model. Never put a gateway key in source control.

Open `http://localhost:3000` and use the local demo account:

- Email: `demo@changegraph.dev`
- Password: `demo1234`

The first server request creates `data/changegraph.db` and seeds the Northstar Platform demo workspace. The demo incident is a deliberate faulty deployment scenario, and the UI labels seed data and disconnected integrations clearly.

`GET /api/health` is available for deployment readiness checks. It reports the SQLite single-host storage boundary, schema migration version, and event-worker heartbeat. Run `npm run worker:events` in a second terminal to continuously process received and retryable events and recover stale processing leases. For a single-host container deployment, use the included `Dockerfile` and `docker-compose.yml` with a durable `/app/data` volume. Do not use a sample secret in a deployed environment.

`GET /api/metrics` is an authenticated owner/admin endpoint for workspace-scoped operational counts. It reports open incidents, recent deployments, telemetry references, event-inbox state, dead letters, and the worker heartbeat. Add `?format=prometheus` for a scrape-friendly text response. Internal monitors may use `x-changegraph-metrics-token` with `CHANGEGRAPH_METRICS_TOKEN`; the ingest token is accepted as a compatibility fallback for a single-host setup.

### Docker Desktop

With Docker Desktop running, set a deployment-only secret in your shell and start both the web process and event worker:

```powershell
$env:AUTH_SECRET = "generate-a-long-random-value-for-this-machine"
$env:CHANGEGRAPH_SEED_DEMO = "true" # Explicitly opt into the seeded portfolio demo.
docker compose up --build
```

Compose builds separate, non-root web and event-worker images. The web image uses Next.js standalone output; the worker is bundled during the image build and includes only its required SQLite runtime files. Both processes share the durable `/app/data` volume. The build compiles `better-sqlite3` inside the build stage and uses an isolated in-memory database so Next.js parallel workers never contend with the runtime volume.

If Next reports `Cannot find module './vendor-chunks/@vercel.js'` during local development, stop the dev server and clear only the generated Next cache:

```powershell
node -e "require('fs').rmSync('.next',{recursive:true,force:true})"
npm run dev
```

This does not delete `data/changegraph.db`, source files, or credentials. The error is a stale/incomplete development vendor-chunk manifest, not an application data failure.

If the build also warns that `@next/swc-win32-x64-msvc` is not a valid Win32 application, use Node.js 22 LTS for this repository and reinstall dependencies. Next can fall back to its WASM compiler, so this warning is a local compiler-performance issue rather than a ChangeGraph runtime failure.

## What works in this phase

- Registration creates a workspace, owner membership, and a verification token.
- Login, logout, email verification, forgot password, and reset password use signed HttpOnly sessions and persisted SQLite records.
- Protected application routes enforce workspace membership server-side.
- Workspace switching, workspace creation, profile updates, workspace settings, member management, and role changes persist through server routes.
- Overview, incidents, services, changes, integrations, evaluations, settings, and a new-incident form are functional.
- The incident detail view contains a replayable timeline with source links for metrics, deployments, traces, logs, and runbooks.
- The deterministic health pass establishes service baselines, detects meaningful error-rate/latency/SLO deviations, creates incidents when multiple unlinked anomalies agree, and ranks deployment, dependency, and signal hypotheses with explainable factors.
- The read-only baseline and optional model investigation agents store structured output, tool calls, evidence references, confidence, latency, token usage when available, and an explicit `uncertain`/`abstain` state. Model claims are filtered against evidence references actually returned by read-only tools.
- The seeded evaluation suite can be replayed and persists top-three cause accuracy, evidence coverage, detection lag, appropriate abstention, and per-case results. No benchmark metric is shown before a replay has completed.
- `npm run eval:gate` replays the three seeded deterministic cases in CI. It requires each case to pass, full top-three cause accuracy, full evidence coverage, correct abstention, and average detection lag under two minutes. These are regression thresholds for the seeded examples, not a claim about real-world incident accuracy or model quality.
- `POST /api/ingest/otel/v1/traces`, `/metrics`, and `/logs` accept workspace-scoped OTLP-compatible JSON when `CHANGEGRAPH_INGEST_TOKEN` and its matching `CHANGEGRAPH_INGEST_WORKSPACE_ID` are configured. Events are versioned, idempotent, retried, and linked to telemetry references.
- `POST /api/github/webhook` verifies `x-hub-signature-256`, normalizes push and deployment events, and requires `GITHUB_WORKSPACE_ID` plus `GITHUB_WEBHOOK_SECRET`.
- `POST /api/events` accepts authenticated, workspace-member ChangeGraph events for local or internal producers. `POST /api/events/process` replays pending events and exposes the retry/dead-letter worker path to an admin or ingest-token caller.
- `POST /api/events/dead-letter/:id` lets an owner/admin or ingest-token worker replay one dead-letter event after its configuration problem is fixed.
- Integration status is server-derived: `connected` means a verified event processed successfully, `pending` means configuration exists but no verified event has completed, `misconfigured` means required configuration is missing or failed, and `demo-only` means seeded sample data. Sample records are never presented as live provider data.

## Ingestion data flow

Provider or collector -> authenticated route -> versioned `event_inbox` row -> idempotent event processor -> workspace-scoped product records (`services`, `changes`, `deployments`, `telemetry_references`, and timeline evidence) -> `audit_events`. Failed processing is retried with exponential backoff; after three attempts the original event and error are preserved in `dead_letter_events` for replay or inspection. Every handler checks the event workspace before writing and queries its related records with the same workspace scope.

The event envelope currently uses `schemaVersion: 1` and one of `source.change.v1`, `deployment.v1`, `service.metadata.v1`, or `telemetry.reference.v1`. The local seed includes a three-service dependency graph, a deliberately faulty checkout deployment, a correlated dependency degradation, an insufficient-evidence abstention case, linked metric/trace/log references, and `demo-only` integration rows.

Detection data flow: stored signals -> historical per-service metric baselines -> thresholded anomalies -> incident correlation -> nearby deployment/dependency ranking -> persisted hypotheses and evidence links. Model investigation data flow: incident context -> narrow workspace-scoped read-only retrieval tools -> structured model output -> evidence-reference validation -> persisted investigation and tool/latency/token audit rows. The model can suggest validation steps, but it cannot mutate incident state or present a hypothesis as proven causality.

## Architecture notes

The current implementation uses Next.js 16.4.6, TypeScript, SQLite, and a small SQL data layer so the portfolio project is runnable without external services. The schema intentionally separates product data, signal payloads, memberships, sessions, provenance, evaluation cases, and worker heartbeats. Node.js 22 or newer is required because the AI SDK runtime depends on it. `CHANGEGRAPH_DB_PATH` makes the database location explicit, and the included container deployment persists it on a durable volume for a single application host. Multi-instance deployments should move this boundary to PostgreSQL without changing the route contract.

The local baseline investigator is deliberately provider-free. The optional model-backed agent uses the AI SDK Gateway adapter and the same `InvestigationOutput` shape behind `src/lib/agent.ts`; its tools are read-only and every accepted claim must point at a reference captured by a tool call. Incident fields and tool results are treated as untrusted data, common credential formats are redacted, and evidence passed to or stored from tools is bounded. This pattern-based redaction is a safety baseline, not a substitute for workspace-specific data classification or a full DLP policy. The evaluation replay defaults to the deterministic agent so local benchmark runs are reproducible without an external model.

The event path is safe to run as a separate local worker with `npm run worker:events`. Each event is accepted into the inbox before processing, protected by an idempotency key, claimed with a lease, retried with backoff, and preserved in the dead-letter table when the attempt ceiling is reached. An owner/admin can replay a dead-letter event after fixing its configuration. The worker also writes a heartbeat row so `/api/health`, `/api/metrics`, and the Integrations page can distinguish an available web process from a stale event worker.

Opt-in PostgreSQL migrations now cover identity, workspace-scoped domain tables, and tenant-enforcing relationships; a tested queue primitive covers idempotent event acceptance, claims, retries, dead letters, and lease fencing. The web app and worker still use SQLite; `DATABASE_URL` is only for these explicit schema/repository checks and does not switch runtime storage. See [docs/POSTGRES_MIGRATION.md](docs/POSTGRES_MIGRATION.md) for the isolated local setup and remaining migration boundary.

Vercel deployment is not yet supported for the functional app: SQLite needs a shared durable volume and the event worker needs a running process. See [docs/VERCEL_DEPLOYMENT.md](docs/VERCEL_DEPLOYMENT.md) for the readiness gate and future configuration inventory. No live Vercel service is implied by the build or demo UI.

## Remaining production work

- Configure a verified email provider as the production default; keep the local one-time-link flow development-only.
- Add GitHub App OAuth and repository installation management around the signed webhook path.
- Add an OTLP collector or ClickHouse-backed signal store for high-volume traces, metrics, and logs; the current app stores references and compact payloads in SQLite for local development.
- Add per-workspace model budgets, workspace-specific PII/data classification, provider health policy, and CI quality gates beyond the seeded regression benchmark.
- Move the SQLite schema to PostgreSQL when deploying across multiple application instances. The current container path is safe for a single persistent Node host with a durable volume, but SQLite is not suitable for serverless multi-instance deployments.
- Replace the database-backed single-host rate limiter with a shared Redis/edge limiter for multi-instance deployments.
- Replace the local worker with a durable queue and add worker metrics before processing high-volume production traffic.

## Verification and release checks

The repository includes `npm run lint`, `npm run typecheck`, `npm test`, `npm run test:postgres`, `npm audit --omit=dev`, `npm run build`, `npm run test:smoke`, and `npm run test:browser` checks. `npm run test:postgres` validates the opt-in PostgreSQL migrations, identity/workspace repository, event-store semantics, and representative tenant constraints; see [docs/POSTGRES_MIGRATION.md](docs/POSTGRES_MIGRATION.md) for the isolated local database setup. `npm run verify` runs the standard static checks, unit/integration tests, audit, and production build as one local release gate. Browser checks use Playwright and axe against the landing/auth surfaces and the authenticated app routes at desktop, tablet, and mobile widths. Run `npx playwright install chromium` once on a new machine before `npm run test:browser`. CI also runs the PostgreSQL migration/repository check, starts the production web process and event worker, and verifies a fresh worker heartbeat through the production smoke flow on pushes and pull requests. The smoke flow covers the public landing page, protected-route redirect, demo login, authenticated overview, incident detail, settings audit trail, integration worker status, and logout. Tests cover agent evidence redaction and size limits, detection/evaluation replay, integration-state truthfulness, versioned event idempotency, workspace isolation, password/session safety, stale event lease recovery, and database-backed rate limits. Sensitive workspace, authentication, membership, and incident actions are recorded in the workspace audit trail. The rate limiter and event worker are intentionally dependency-free for the single-host path; a shared low-latency limiter and durable queue are still required when running more than one application instance at production scale.

All application responses also receive a centralized browser security-header baseline. The CSP is intentionally conservative for the current first-party UI; review it and move to nonce-based CSP before adding third-party scripts.

For the supported single-host deployment mode, `npm run backup:db` creates a consistent SQLite snapshot under `data/backups` (or `CHANGEGRAPH_BACKUP_DIR`) and verifies its integrity and migration version. See [docs/OPERATIONS.md](docs/OPERATIONS.md) for backup, restore, readiness, and incident-response procedures.
