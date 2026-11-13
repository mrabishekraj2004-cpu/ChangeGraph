# ChangeGraph portfolio notes

## One-line description

ChangeGraph is an evidence-linked incident investigation workspace for platform and SRE teams. It correlates service health, deployments, code changes, dependencies, telemetry, runbooks, and prior incidents while preserving uncertainty.

## What to demonstrate

1. Open the seeded demo and show the deliberately faulty checkout deployment.
2. Follow the incident timeline from the health signal to deployment, trace, log, and runbook evidence.
3. Run the deterministic investigation and point out the ranked hypothesis factors.
4. Run the optional AI investigation without model credentials and show the explicit abstention.
5. Replay the evaluation suite and show that benchmark metrics are persisted only after a run.
6. Open Integrations and show that demo-only data is not presented as a connected provider.

## Honest positioning

Use: **professional incident intelligence prototype with production-oriented architecture**.

The project has real authentication, workspace authorization, ingestion normalization, retry/dead-letter behavior, deterministic detection, evidence provenance, evaluation replay, a worker heartbeat, an audit trail, and database-backed rate limiting. It is not yet a multi-instance production SaaS platform because SQLite, email delivery, high-volume telemetry storage, shared rate-limit infrastructure, and durable queue infrastructure still need external deployment work.

## Strong engineering talking points

- Every workspace query carries a server-side workspace boundary.
- Event processing is idempotent and replayable.
- Stale worker leases are recoverable.
- AI tools are narrow and read-only.
- AI claims must reference retrieved evidence.
- The system can abstain when evidence is insufficient.
- Seeded incidents have known causes for replayable evaluation.
- Integration status distinguishes connected, pending, misconfigured, and demo-only states.
