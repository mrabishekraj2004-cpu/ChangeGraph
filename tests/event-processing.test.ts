import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";

let dbModule: typeof import("../src/lib/db");
let eventModule: typeof import("../src/lib/event-processing");
let securityModule: typeof import("../src/lib/security");
let identityModule: typeof import("../src/lib/identity-repository");
let tempDirectory: string;

before(async () => {
  tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "changegraph-test-"));
  process.env.AUTH_SECRET = "test-secret-that-is-at-least-32-characters-long";
  process.env.CHANGEGRAPH_DB_PATH = path.join(tempDirectory, "changegraph.db");
  dbModule = await import("../src/lib/db");
  eventModule = await import("../src/lib/event-processing");
  securityModule = await import("../src/lib/security");
  identityModule = await import("../src/lib/identity-repository");
});

after(() => {
  dbModule.db.close();
  fs.rmSync(tempDirectory, { recursive: true, force: true });
});

describe("ChangeGraph event processing", () => {
  test("processes a versioned event once and returns the same inbox row for duplicates", () => {
    dbModule.seedDemoData();
    const event = {
      schemaVersion: 1 as const,
      eventId: "evt_test_change_1",
      eventType: "source.change.v1" as const,
      source: "test",
      externalId: "sha-test-1",
      idempotencyKey: "test:change:sha-test-1",
      workspaceId: "ws_northstar_demo",
      occurredAt: new Date().toISOString(),
      payload: {
        sha: "sha-test-1",
        title: "Test change",
        author: "Test author",
        repository: "test/repository",
      },
    };

    const accepted = eventModule.ingestEvent(event);
    const processed = eventModule.processEvent(accepted.eventId);
    const duplicate = eventModule.ingestEvent(event);

    assert.equal(accepted.accepted, true);
    assert.equal(processed.status, "processed");
    assert.equal(duplicate.duplicate, true);
    assert.equal(duplicate.eventId, accepted.eventId);
    assert.equal(dbModule.countRecentDeployments("ws_northstar_demo"), 1);
    assert.equal(
      (dbModule.db.prepare("SELECT COUNT(*) AS count FROM changes WHERE workspace_id = ? AND sha = ?").get("ws_northstar_demo", "sha-test-1") as { count: number }).count,
      1,
    );
  });

  test("does not expose a service from another workspace", () => {
    assert.equal(dbModule.getServiceForWorkspace("workspace-that-does-not-exist", "svc_checkout"), undefined);
    assert.equal(dbModule.getOperationalMetrics("workspace-that-does-not-exist").openIncidents, 0);
  });

  test("keeps mutation limits in the shared database", () => {
    const previousProxyHops = process.env.CHANGEGRAPH_TRUSTED_PROXY_HOPS;
    process.env.CHANGEGRAPH_TRUSTED_PROXY_HOPS = "1";
    try {
      const request = new Request("http://localhost/api/test", { method: "POST", headers: { origin: "http://localhost", "x-forwarded-for": "198.51.100.20" } });
      assert.equal(securityModule.mutationGuard(request, "test:shared", { limit: 2, windowMs: 60_000 }), null);
      assert.equal(securityModule.mutationGuard(request, "test:shared", { limit: 2, windowMs: 60_000 }), null);
      const blocked = securityModule.mutationGuard(request, "test:shared", { limit: 2, windowMs: 60_000 });
      assert.equal(blocked?.status, 429);
      assert.equal((dbModule.db.prepare("SELECT count, reset_at FROM rate_limit_buckets WHERE bucket_key = ?").get("test:shared:198.51.100.20") as { count: number; reset_at: number }).count, 3);
    } finally {
      if (previousProxyHops === undefined) delete process.env.CHANGEGRAPH_TRUSTED_PROXY_HOPS;
      else process.env.CHANGEGRAPH_TRUSTED_PROXY_HOPS = previousProxyHops;
    }
  });

  test("does not let untrusted forwarding headers bypass rate limits", () => {
    const previousProxyHops = process.env.CHANGEGRAPH_TRUSTED_PROXY_HOPS;
    delete process.env.CHANGEGRAPH_TRUSTED_PROXY_HOPS;
    try {
      const request = (forwardedFor: string) => new Request("http://localhost/api/test", { method: "POST", headers: { origin: "http://localhost", "x-forwarded-for": forwardedFor, "x-real-ip": forwardedFor } });
      assert.equal(securityModule.mutationGuard(request("198.51.100.21"), "test:spoofed", { limit: 1, windowMs: 60_000 }), null);
      assert.equal(securityModule.mutationGuard(request("198.51.100.22"), "test:spoofed", { limit: 1, windowMs: 60_000 })?.status, 429);
    } finally {
      if (previousProxyHops === undefined) delete process.env.CHANGEGRAPH_TRUSTED_PROXY_HOPS;
      else process.env.CHANGEGRAPH_TRUSTED_PROXY_HOPS = previousProxyHops;
    }
  });

  test("uses the client address at the trusted proxy boundary", () => {
    const previousProxyHops = process.env.CHANGEGRAPH_TRUSTED_PROXY_HOPS;
    process.env.CHANGEGRAPH_TRUSTED_PROXY_HOPS = "1";
    try {
      const request = (forwardedFor: string) => new Request("http://localhost/api/test", { method: "POST", headers: { origin: "http://localhost", "x-forwarded-for": forwardedFor } });
      assert.equal(securityModule.mutationGuard(request("203.0.113.99, 198.51.100.23"), "test:trusted-proxy", { limit: 1, windowMs: 60_000 }), null);
      assert.equal(securityModule.mutationGuard(request("192.0.2.44, 198.51.100.23"), "test:trusted-proxy", { limit: 1, windowMs: 60_000 })?.status, 429);
      assert.equal(securityModule.mutationGuard(request("203.0.113.99, 198.51.100.24"), "test:trusted-proxy", { limit: 1, windowMs: 60_000 }), null);
    } finally {
      if (previousProxyHops === undefined) delete process.env.CHANGEGRAPH_TRUSTED_PROXY_HOPS;
      else process.env.CHANGEGRAPH_TRUSTED_PROXY_HOPS = previousProxyHops;
    }
  });

  test("accepts the configured public origin behind a standalone server and rejects other origins", () => {
    const previousAppUrl = process.env.APP_URL;
    process.env.APP_URL = "https://changegraph.example.com";
    try {
      assert.equal(
        securityModule.sameOrigin(new Request("http://changegraph:3000/api/test", { headers: { origin: "https://changegraph.example.com" } })),
        true,
      );
      assert.equal(
        securityModule.sameOrigin(new Request("http://changegraph:3000/api/test", { headers: { origin: "https://attacker.example" } })),
        false,
      );
      assert.equal(
        securityModule.sameOrigin(new Request("http://localhost:3000/api/test", { headers: { origin: "http://localhost:3000" } })),
        true,
      );
    } finally {
      if (previousAppUrl === undefined) delete process.env.APP_URL;
      else process.env.APP_URL = previousAppUrl;
    }
  });

  test("stores workspace audit events with actor provenance", () => {
    const user = dbModule.getUserByEmail("demo@changegraph.dev");
    assert.ok(user);
    dbModule.recordAuditEvent({ workspaceId: "ws_northstar_demo", actorUserId: user.id, action: "test.audit", entityType: "test", entityId: "audit-1", metadata: { source: "test" } });
    const event = dbModule.listAuditEvents("ws_northstar_demo", 1)[0];
    assert.equal(event.action, "test.audit");
    assert.equal(event.actor_email, "demo@changegraph.dev");
    assert.deepEqual(JSON.parse(event.metadata_json), { source: "test" });
  });

  test("reclaims a stale processing lease", () => {
    const event = {
      schemaVersion: 1 as const,
      eventId: "evt_test_lease_1",
      eventType: "service.metadata.v1" as const,
      source: "test",
      externalId: "service-lease-1",
      idempotencyKey: "test:service:lease-1",
      workspaceId: "ws_northstar_demo",
      occurredAt: new Date().toISOString(),
      payload: {
        slug: "checkout-api",
        name: "checkout-api",
        owner: "Test owner",
      },
    };
    const accepted = eventModule.ingestEvent(event);
    dbModule.db.prepare("UPDATE event_inbox SET status = 'processing', processing_started_at = ?, processing_worker_id = ? WHERE id = ?").run("2000-01-01T00:00:00.000Z", "stale-worker", accepted.eventId);
    const processed = eventModule.processEvent(accepted.eventId);
    assert.equal(processed.status, "processed");
  });

  test("revokes sessions after a password reset and consumes verification tokens once", () => {
    const created = dbModule.createUser({ email: "auth-test@example.com", password: "old-password", name: "Auth Test" });
    const session = dbModule.createSession(created.id, created.workspaceId);
    assert.ok(dbModule.findSession(session.id));
    assert.ok(dbModule.consumeEmailToken(created.verificationToken, "verify"));
    const tokenMatch = dbModule.consumeEmailToken(created.verificationToken, "verify");
    assert.ok(tokenMatch);
    dbModule.markTokenUsed(tokenMatch!.id);
    assert.equal(dbModule.consumeEmailToken(created.verificationToken, "verify"), undefined);
    dbModule.updatePassword(created.id, "new-password");
    assert.equal(dbModule.findSession(session.id), undefined);
  });

  test("uses async identity repository calls for users, workspaces, and sessions", async () => {
    dbModule.seedDemoData();
    const user = await identityModule.identityRepository.getUserByEmail("demo@changegraph.dev");
    assert.ok(user);

    const workspaces = await identityModule.identityRepository.getUserWorkspaces(user!.id);
    assert.ok(workspaces.length > 0);

    const session = await identityModule.identityRepository.createSession(user!.id, workspaces[0].id);
    assert.equal((await identityModule.identityRepository.findSession(session.id))?.user_id, user!.id);
    assert.equal(await identityModule.identityRepository.switchSessionWorkspace(session.id, user!.id, workspaces[0].id), true);
    await identityModule.identityRepository.removeSession(session.id);
    assert.equal(await identityModule.identityRepository.findSession(session.id), undefined);
  });

  test("keeps workspace membership scoped and prevents removing the last owner", async () => {
    dbModule.seedDemoData();
    const owner = await identityModule.identityRepository.getUserByEmail("demo@changegraph.dev");
    assert.ok(owner);

    const workspace = await identityModule.identityRepository.createWorkspace(owner!.id, { name: "Repository Test Workspace", mode: "production" });
    assert.equal((await identityModule.identityRepository.getWorkspaceForUser(owner!.id, workspace.id))?.role, "owner");

    const member = await identityModule.identityRepository.createUser({ email: "repository-member@example.com", password: "test-password-123", name: "Repository Member" });
    assert.deepEqual(await identityModule.identityRepository.addWorkspaceMember(workspace.id, "repository-member@example.com", "member"), { ok: true, userId: member.id });
    const duplicateMember = await identityModule.identityRepository.addWorkspaceMember(workspace.id, "repository-member@example.com", "member");
    assert.equal(duplicateMember.ok, false);
    if (!duplicateMember.ok) assert.equal(duplicateMember.reason, "exists");
    assert.equal(await identityModule.identityRepository.updateWorkspaceMemberRole(workspace.id, member.id, "responder"), true);

    const members = await identityModule.identityRepository.listWorkspaceMembers(workspace.id);
    assert.equal(members.length, 2);
    assert.equal(members.find((entry) => entry.id === member.id)?.role, "responder");
    assert.equal(await identityModule.identityRepository.getWorkspaceForUser(owner!.id, member.workspaceId), undefined);
    assert.equal(await identityModule.identityRepository.updateWorkspaceMemberRole(workspace.id, owner!.id, "member"), false);
    assert.equal(await identityModule.identityRepository.removeWorkspaceMember(workspace.id, owner!.id), false);

    await identityModule.identityRepository.recordAuditEvent({ workspaceId: workspace.id, actorUserId: owner!.id, action: "test.workspace", entityType: "workspace", entityId: workspace.id, metadata: { scope: "repository" } });
    const [audit] = await identityModule.identityRepository.listAuditEvents(workspace.id, 1);
    assert.equal(audit.action, "test.workspace");
    assert.equal(audit.actor_email, "demo@changegraph.dev");
  });

  test("moves malformed events to the dead-letter path and can replay them", () => {
    process.env.CHANGEGRAPH_MAX_EVENT_ATTEMPTS = "1";
    const eventId = "evt_test_invalid_1";
    dbModule.db.prepare(
      "INSERT INTO event_inbox (id, workspace_id, source, event_type, schema_version, external_id, idempotency_key, payload_json, headers_json, status, received_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(eventId, "ws_northstar_demo", "test", "source.change.v1", 1, "invalid-1", "test:invalid:1", JSON.stringify({ eventType: "source.change.v1" }), "{}", "received", new Date().toISOString());
    const deadLettered = eventModule.processEvent(eventId);
    assert.equal(deadLettered.status, "dead_letter");
    const deadLetter = dbModule.db.prepare("SELECT id FROM dead_letter_events WHERE event_id = ?").get(eventId) as { id: string } | undefined;
    assert.ok(deadLetter);
    const replayed = eventModule.replayDeadLetter("ws_northstar_demo", deadLetter!.id);
    assert.equal(replayed?.eventId, eventId);
    assert.equal(eventModule.processEvent(eventId).status, "dead_letter");
    delete process.env.CHANGEGRAPH_MAX_EVENT_ATTEMPTS;
  });
});
