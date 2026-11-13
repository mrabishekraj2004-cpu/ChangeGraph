# Security notes

## Local secrets

Copy `.env.example` to `.env.local` and keep it untracked. Never commit `AUTH_SECRET`, provider API keys, webhook secrets, or ingest tokens. The repository ignores `.env*`, the local database, and private key files.

## Current protections

- Passwords are hashed with bcrypt.
- Sessions are signed, HttpOnly, SameSite, expiring, and revocable in the database.
- Password reset invalidates existing user sessions.
- Verification and reset tokens are stored hashed and are single-use and expiring.
- JSON mutations validate same-origin requests when an Origin header is supplied.
- Authentication and write routes have database-backed rate limits, so limits remain consistent across web processes that share the configured database.
- GitHub webhooks use timing-safe HMAC verification.
- Server-side workspace membership and role checks protect application writes.
- Operational metrics are workspace-scoped and require an owner/admin session or the explicitly configured metrics token; they do not expose provider credentials or raw telemetry payloads.
- All application responses receive a centralized browser security-header baseline: CSP, frame denial, MIME sniffing protection, strict referrer handling, restrictive permissions, and same-origin isolation headers.

## Production requirements

The current limiter shares state through the application database. For horizontally scaled deployments, move the bucket store to a low-latency shared service such as Redis or a managed rate-limit provider, and trust forwarded client IP headers only at a known proxy boundary. Add centralized security event logging, abuse monitoring, a real email provider, external secret management, and a documented CSRF/origin policy before handling sensitive production data.

The current CSP allows inline styles and inline scripts because Next.js renders framework bootstrap code without a nonce in this application. Before embedding third-party scripts or handling higher-risk production data, move to nonce-based CSP or a deployment-specific policy and review every external origin.
