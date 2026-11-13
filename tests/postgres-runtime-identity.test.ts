import assert from "node:assert/strict";
import test from "node:test";
import { createRuntimeIdentityRepository, type IdentityStore } from "../src/lib/identity-repository";

function stubStore(name: string): IdentityStore {
  return { getUserByEmail: async () => ({ id: name }) } as unknown as IdentityStore;
}

test("SQLite is selected when DATABASE_URL is empty or blank, even with the flag", async () => {
  for (const databaseUrl of ["", "  "]) {
    let sqliteLoads = 0;
    let postgresLoads = 0;
    const repository = createRuntimeIdentityRepository(databaseUrl, {
      sqlite: async () => { sqliteLoads++; return stubStore("sqlite"); },
      postgres: async () => { postgresLoads++; return stubStore("postgres"); },
    }, "true");
    assert.equal((await repository.getUserByEmail("one@example.com"))?.id, "sqlite");
    await repository.getUserByEmail("two@example.com");
    assert.equal(sqliteLoads, 1);
    assert.equal(postgresLoads, 0);
  }
});

test("the default selection requires both environment variables", async () => {
  const repository = createRuntimeIdentityRepository(undefined, {
    sqlite: async () => stubStore("sqlite"),
    postgres: async () => stubStore("postgres"),
  });
  const expected = process.env.CHANGEGRAPH_POSTGRES_IDENTITY_EXPERIMENTAL === "true" && process.env.DATABASE_URL?.trim()
    ? "postgres" : "sqlite";
  assert.equal((await repository.getUserByEmail("one@example.com"))?.id, expected);
});

test("DATABASE_URL alone keeps SQLite selected", async () => {
  for (const flag of [undefined, "", "false", "TRUE", "1"]) {
    let postgresLoads = 0;
    const repository = createRuntimeIdentityRepository("postgres://private-connection", {
      sqlite: async () => stubStore("sqlite"),
      postgres: async () => { postgresLoads++; return stubStore("postgres"); },
    }, flag ?? "");
    assert.equal((await repository.getUserByEmail("one@example.com"))?.id, "sqlite");
    assert.equal(postgresLoads, 0);
  }
});

test("explicit experimental flag and DATABASE_URL select PostgreSQL lazily", async () => {
  let sqliteLoads = 0;
  const urls: string[] = [];
  const repository = createRuntimeIdentityRepository("  postgres://private-connection  ", {
    sqlite: async () => { sqliteLoads++; return stubStore("sqlite"); },
    postgres: async (url) => { urls.push(url); return stubStore("postgres"); },
  }, "true");
  assert.deepEqual(urls, []);
  const users = await Promise.all([
    repository.getUserByEmail("one@example.com"),
    repository.getUserByEmail("two@example.com"),
  ]);
  assert.deepEqual(users.map((user) => user?.id), ["postgres", "postgres"]);
  assert.equal(sqliteLoads, 0);
  assert.equal(urls.length, 1);
  assert.equal(urls[0], "postgres://private-connection");
});

test("PostgreSQL load failure does not fall back to SQLite", async () => {
  let sqliteLoads = 0;
  const repository = createRuntimeIdentityRepository("postgres://private-connection", {
    sqlite: async () => { sqliteLoads++; return stubStore("sqlite"); },
    postgres: async () => { throw new Error("database unavailable"); },
  }, "true");
  await assert.rejects(repository.getUserByEmail("one@example.com"), /database unavailable/);
  assert.equal(sqliteLoads, 0);
});
