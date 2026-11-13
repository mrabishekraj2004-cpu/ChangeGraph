import assert from "node:assert/strict";

const baseUrl = (process.env.BASE_URL || "http://localhost:3000").replace(/\/$/, "");

async function request(path, init = {}) {
  return fetch(`${baseUrl}${path}`, { redirect: "manual", ...init });
}

async function waitForHealth() {
  const deadline = Date.now() + 30_000;
  let lastError = "server did not respond";
  while (Date.now() < deadline) {
    try {
      const response = await request("/api/health");
      if (response.ok) return response;
      lastError = `health returned ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Smoke test could not reach ${baseUrl}: ${lastError}`);
}

function sessionCookie(response) {
  const values = typeof response.headers.getSetCookie === "function" ? response.headers.getSetCookie() : [];
  const raw = values[0] || response.headers.get("set-cookie") || "";
  return raw.split(";", 1)[0];
}

const healthResponse = await waitForHealth();
const health = await healthResponse.json();
assert.equal(health.status, "ok");
assert.equal(health.database, "ready");
assert.equal(health.storage?.provider, "sqlite");
assert.equal(health.storage?.deploymentMode, "single_host");
assert.ok(Number(health.migrationVersion) >= 8);
if (process.env.SMOKE_REQUIRE_WORKER === "true") {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const current = await (await request("/api/health")).json();
    if (current.worker?.status === "healthy") break;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  const workerHealth = await (await request("/api/health")).json();
  assert.equal(workerHealth.worker?.status, "healthy", "event worker should report a fresh heartbeat");
}

const landing = await request("/");
assert.equal(landing.status, 200);
assert.match(await landing.text(), /Find the change/i);
assert.equal(landing.headers.get("x-content-type-options"), "nosniff");
assert.equal(landing.headers.get("x-frame-options"), "DENY");
assert.equal(landing.headers.get("referrer-policy"), "strict-origin-when-cross-origin");
assert.match(landing.headers.get("content-security-policy") || "", /default-src 'self'/);

const loginPage = await request("/login");
assert.equal(loginPage.status, 200);
assert.match(await loginPage.text(), /Welcome back/i);

const protectedRedirect = await request("/overview");
assert.ok([307, 308].includes(protectedRedirect.status));
assert.match(protectedRedirect.headers.get("location") || "", /\/login/);

const login = await request("/api/auth/login", {
  method: "POST",
  headers: { "content-type": "application/json", origin: baseUrl },
  body: JSON.stringify({ email: "demo@changegraph.dev", password: "demo1234" }),
});
assert.equal(login.status, 200);
const cookie = sessionCookie(login);
assert.ok(cookie, "login should issue a session cookie");

const overview = await request("/overview", { headers: { cookie } });
assert.equal(overview.status, 200);
const overviewHtml = await overview.text();
assert.match(overviewHtml, /Northstar Platform|Good morning/i);
assert.match(overviewHtml, /class="skip-link"/i);
assert.match(overviewHtml, /<main id="main-content">/i);
assert.match(overviewHtml, /aria-label="Primary navigation"/i);

const incident = await request("/incidents/inc_1047", { headers: { cookie } });
assert.equal(incident.status, 200);
assert.match(await incident.text(), /Incident timeline/i);

const incidents = await request("/incidents", { headers: { cookie } });
assert.equal(incidents.status, 200);
const incidentsHtml = await incidents.text();
assert.match(incidentsHtml, /aria-label="Primary navigation"/i);
assert.match(incidentsHtml, /<main id="main-content">/i);

const settings = await request("/settings", { headers: { cookie } });
assert.equal(settings.status, 200);
assert.match(await settings.text(), /Audit trail/i);

const integrations = await request("/integrations", { headers: { cookie } });
assert.equal(integrations.status, 200);
assert.match(await integrations.text(), /event worker/i);

const evaluations = await request("/evaluations", { headers: { cookie } });
assert.equal(evaluations.status, 200);
const evaluationsHtml = await evaluations.text();
assert.match(evaluationsHtml, /Agent configuration/i);
if (!process.env.AI_GATEWAY_API_KEY?.trim()) assert.match(evaluationsHtml, /baseline only/i);

const metrics = await request("/api/metrics", { headers: { cookie } });
assert.equal(metrics.status, 200);
const metricsBody = await metrics.json();
assert.equal(metricsBody.workspaceId, "ws_northstar_demo");
assert.ok(typeof metricsBody.metrics.openIncidents === "number");

const prometheusMetrics = await request("/api/metrics?format=prometheus", { headers: { cookie } });
assert.equal(prometheusMetrics.status, 200);
assert.match(await prometheusMetrics.text(), /changegraph_open_incidents/);

const logout = await request("/api/auth/logout", { method: "POST", headers: { cookie, origin: baseUrl } });
assert.equal(logout.status, 200);

const afterLogout = await request("/overview", { headers: { cookie } });
assert.ok([307, 308].includes(afterLogout.status));
assert.match(afterLogout.headers.get("location") || "", /\/login/);

console.log(JSON.stringify({ baseUrl, status: "passed", checks: ["health", ...(process.env.SMOKE_REQUIRE_WORKER === "true" ? ["worker-heartbeat"] : []), "landing", "security-headers", "protected-route", "login", "overview", "shell-accessibility-contract", "incident-detail", "settings-audit", "integrations-worker-status", "evaluations-configuration", "operational-metrics", "prometheus-metrics", "logout"] }));
