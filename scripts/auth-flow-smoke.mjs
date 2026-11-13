import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:net";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

async function reservePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

async function stopServer(server) {
  if (server.exitCode !== null || server.signalCode !== null) return;
  if (process.platform === "win32") {
    const killer = spawn("taskkill", ["/pid", String(server.pid), "/t", "/f"], { stdio: "ignore", windowsHide: true });
    await new Promise((resolve) => killer.once("exit", resolve));
    return;
  }
  server.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => server.once("exit", resolve)),
    delay(8_000).then(() => { server.kill("SIGKILL"); }),
  ]);
}

async function main() {
  const port = await reservePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const server = spawn(process.execPath, [path.join(process.cwd(), "node_modules/next/dist/bin/next"), "dev", "--webpack", "--port", String(port)], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      APP_URL: baseUrl,
      AUTH_SECRET: randomBytes(32).toString("base64url"),
      CHANGEGRAPH_DB_PATH: ":memory:",
      EMAIL_PROVIDER: "none",
    },
    stdio: "ignore",
    windowsHide: true,
  });

  try {
    let ready = false;
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
      if (server.exitCode !== null) throw new Error("Development server exited before becoming ready.");
      try {
        const response = await fetch(`${baseUrl}/api/health`);
        if (response.ok) { ready = true; break; }
      } catch {
        // The dev server may still be compiling its first route.
      }
      await delay(500);
    }
    assert.ok(ready, "Development server did not become ready within 90 seconds.");

    const email = `auth-flow-${randomUUID()}@example.test`;
    const oldPassword = `Initial-${randomBytes(12).toString("hex")}!`;
    const newPassword = `Updated-${randomBytes(12).toString("hex")}!`;
    const post = (route, body, extraHeaders = {}) => fetch(`${baseUrl}${route}`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: baseUrl, ...extraHeaders },
      body: JSON.stringify(body),
      redirect: "manual",
    });

    const registration = await post("/api/auth/register", { name: "Auth Flow Check", email, password: oldPassword });
    assert.equal(registration.status, 200, "registration should succeed");
    const registrationBody = await registration.json();
    assert.equal(registrationBody.emailDelivery, "development");
    assert.ok(registrationBody.verificationUrl, "local registration should return a verification link");

    const verification = await fetch(new URL(registrationBody.verificationUrl, baseUrl));
    assert.equal(verification.status, 200);
    assert.match(await verification.text(), /Email verified/);

    const firstLogin = await post("/api/auth/login", { email, password: oldPassword });
    assert.equal(firstLogin.status, 200, "verified account should log in");
    const firstCookie = (firstLogin.headers.getSetCookie?.()[0] || firstLogin.headers.get("set-cookie") || "").split(";", 1)[0];
    assert.ok(firstCookie, "login should issue a session cookie");

    const forgot = await post("/api/auth/forgot", { email });
    assert.equal(forgot.status, 200);
    const forgotBody = await forgot.json();
    assert.ok(forgotBody.resetUrl, "local password recovery should return a reset link");
    const token = new URL(forgotBody.resetUrl, baseUrl).searchParams.get("token");
    assert.ok(token);

    const reset = await post("/api/auth/reset", { token, password: newPassword });
    assert.equal(reset.status, 200, "password reset should succeed");
    const oldSession = await fetch(`${baseUrl}/overview`, { headers: { cookie: firstCookie }, redirect: "manual" });
    assert.ok([307, 308].includes(oldSession.status), "password reset should revoke existing sessions");

    const oldPasswordLogin = await post("/api/auth/login", { email, password: oldPassword });
    assert.equal(oldPasswordLogin.status, 401, "old password should stop working");
    const newLogin = await post("/api/auth/login", { email, password: newPassword });
    assert.equal(newLogin.status, 200, "new password should work");
    const newCookie = (newLogin.headers.getSetCookie?.()[0] || newLogin.headers.get("set-cookie") || "").split(";", 1)[0];
    assert.ok(newCookie);

    const logout = await post("/api/auth/logout", {}, { cookie: newCookie });
    assert.equal(logout.status, 200, "logout should succeed");
    console.log(JSON.stringify({ status: "passed", checks: ["registration", "email verification", "login", "forgot password", "reset password", "session revocation", "logout"] }));
  } finally {
    await stopServer(server);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : "Authentication flow check failed.");
  process.exitCode = 1;
});
