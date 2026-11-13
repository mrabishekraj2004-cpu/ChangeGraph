import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";

let dbModule: typeof import("../src/lib/db");
let integrationsModule: typeof import("../src/lib/integrations");
let githubRoute: typeof import("../src/app/api/github/webhook/route");
let otelRoute: typeof import("../src/app/api/ingest/otel/v1/metrics/route");
let tempDirectory: string;

before(async () => {
  tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "changegraph-integrations-test-"));
  process.env.AUTH_SECRET = "test-secret-that-is-at-least-32-characters-long";
  process.env.CHANGEGRAPH_DB_PATH = path.join(tempDirectory, "changegraph.db");
  delete process.env.GITHUB_WEBHOOK_SECRET;
  delete process.env.GITHUB_WORKSPACE_ID;
  delete process.env.CHANGEGRAPH_INGEST_TOKEN;
  delete process.env.CHANGEGRAPH_INGEST_WORKSPACE_ID;
  dbModule = await import("../src/lib/db");
  integrationsModule = await import("../src/lib/integrations");
  githubRoute = await import("../src/app/api/github/webhook/route");
  otelRoute = await import("../src/app/api/ingest/otel/v1/metrics/route");
});

after(() => {
  delete process.env.GITHUB_WEBHOOK_SECRET;
  delete process.env.GITHUB_WORKSPACE_ID;
  delete process.env.CHANGEGRAPH_INGEST_TOKEN;
  delete process.env.CHANGEGRAPH_INGEST_WORKSPACE_ID;
  dbModule.db.close();
  fs.rmSync(tempDirectory, { recursive: true, force: true });
});

describe("ChangeGraph integration state", () => {
  test("keeps seeded provider records demo-only", () => {
    dbModule.seedDemoData();
    const statuses = integrationsModule.getIntegrationStatuses("ws_northstar_demo");

    assert.equal(statuses.length, 3);
    assert.ok(statuses.every((status) => status.status === "demo_only"));
  });

  test("distinguishes missing configuration, pending verification, and connected state", () => {
    const created = dbModule.createUser({ email: "integration-test@example.com", password: "password-123", name: "Integration Test" });
    const workspaceId = created.workspaceId;
    integrationsModule.ensureIntegrations(workspaceId);

    const misconfigured = integrationsModule.getIntegrationStatuses(workspaceId);
    assert.equal(misconfigured.find((status) => status.provider === "github")?.status, "misconfigured");
    assert.equal(misconfigured.find((status) => status.provider === "otel")?.status, "misconfigured");

    process.env.GITHUB_WEBHOOK_SECRET = "test-github-secret";
    process.env.GITHUB_WORKSPACE_ID = workspaceId;
    process.env.CHANGEGRAPH_INGEST_TOKEN = "test-otel-token";
    process.env.CHANGEGRAPH_INGEST_WORKSPACE_ID = workspaceId;

    const pending = integrationsModule.getIntegrationStatuses(workspaceId);
    assert.equal(pending.find((status) => status.provider === "github")?.status, "pending");
    assert.equal(pending.find((status) => status.provider === "otel")?.status, "pending");

    integrationsModule.markIntegrationStatus(workspaceId, "github", "connected");
    const connected = integrationsModule.getIntegrationStatuses(workspaceId);
    assert.equal(connected.find((status) => status.provider === "github")?.status, "connected");
    assert.equal(connected.find((status) => status.provider === "github")?.lastSuccessAt !== null, true);
  });

  test("verifies GitHub signatures and normalizes a push exactly once", async () => {
    dbModule.seedDemoData();
    const secret = "webhook-test-secret";
    process.env.GITHUB_WEBHOOK_SECRET = secret;
    process.env.GITHUB_WORKSPACE_ID = "ws_northstar_demo";
    const payload = JSON.stringify({
      repository: { full_name: "acme/checkout", html_url: "https://github.com/acme/checkout" },
      sender: { login: "octocat" },
      commits: [{ id: "github-test-sha", message: "Improve checkout retries", timestamp: new Date().toISOString(), author: { name: "Octocat" }, url: "https://github.com/acme/checkout/commit/github-test-sha" }],
    });
    const headers = { "content-type": "application/json", "x-github-event": "push", "x-github-delivery": "delivery-test-1" };
    const invalid = await githubRoute.POST(new Request("http://localhost/api/github/webhook", { method: "POST", headers: { ...headers, "x-hub-signature-256": "sha256=invalid" }, body: payload }));
    assert.equal(invalid.status, 401);

    const signature = `sha256=${crypto.createHmac("sha256", secret).update(payload).digest("hex")}`;
    const valid = await githubRoute.POST(new Request("http://localhost/api/github/webhook", { method: "POST", headers: { ...headers, "x-hub-signature-256": signature }, body: payload }));
    assert.equal(valid.status, 202);
    const result = await valid.json() as { normalized: number; results: Array<{ processed: { status: string } }> };
    assert.equal(result.normalized, 1);
    assert.equal(result.results[0].processed.status, "processed");
    assert.equal((dbModule.db.prepare("SELECT COUNT(*) AS count FROM changes WHERE workspace_id = ? AND sha = ?").get("ws_northstar_demo", "github-test-sha") as { count: number }).count, 1);

    const duplicate = await githubRoute.POST(new Request("http://localhost/api/github/webhook", { method: "POST", headers: { ...headers, "x-hub-signature-256": signature }, body: payload }));
    const duplicateResult = await duplicate.json() as { normalized: number; results: Array<{ duplicate: boolean }> };
    assert.equal(duplicateResult.normalized, 1);
    assert.equal(duplicateResult.results[0].duplicate, true);
    assert.equal((dbModule.db.prepare("SELECT COUNT(*) AS count FROM changes WHERE workspace_id = ? AND sha = ?").get("ws_northstar_demo", "github-test-sha") as { count: number }).count, 1);
  });

  test("accepts workspace-bound OTLP metrics and preserves idempotency", async () => {
    dbModule.seedDemoData();
    process.env.CHANGEGRAPH_INGEST_TOKEN = "otel-test-token";
    process.env.CHANGEGRAPH_INGEST_WORKSPACE_ID = "ws_northstar_demo";
    const payload = JSON.stringify({
      resourceMetrics: [{ resource: { attributes: [{ key: "service.name", value: { stringValue: "checkout-api" } }] }, scopeMetrics: [] }],
      observedAt: new Date().toISOString(),
      summary: "checkout latency sample",
    });
    const headers = { "content-type": "application/json", "x-changegraph-ingest-token": "otel-test-token", "x-changegraph-workspace-id": "ws_northstar_demo", "x-request-id": "otel-request-1" };
    const valid = await otelRoute.POST(new Request("http://localhost/api/ingest/otel/v1/metrics", { method: "POST", headers, body: payload }));
    assert.equal(valid.status, 202);
    const result = await valid.json() as { events: Array<{ processed: { status: string } }> };
    assert.equal(result.events[0].processed.status, "processed");
    assert.equal((dbModule.db.prepare("SELECT COUNT(*) AS count FROM telemetry_references WHERE workspace_id = ? AND external_ref = ?").get("ws_northstar_demo", "otel-request-1") as { count: number }).count, 1);

    const duplicate = await otelRoute.POST(new Request("http://localhost/api/ingest/otel/v1/metrics", { method: "POST", headers, body: payload }));
    const duplicateResult = await duplicate.json() as { events: Array<{ duplicate: boolean }> };
    assert.equal(duplicateResult.events[0].duplicate, true);
    assert.equal((dbModule.db.prepare("SELECT COUNT(*) AS count FROM telemetry_references WHERE workspace_id = ? AND external_ref = ?").get("ws_northstar_demo", "otel-request-1") as { count: number }).count, 1);

    const wrongWorkspace = await otelRoute.POST(new Request("http://localhost/api/ingest/otel/v1/metrics", { method: "POST", headers: { ...headers, "x-changegraph-workspace-id": "unknown-workspace" }, body: payload }));
    assert.equal(wrongWorkspace.status, 403);
  });
});
