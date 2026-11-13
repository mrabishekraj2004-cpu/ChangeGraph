import fs from "node:fs/promises";
import path from "node:path";
import Database from "better-sqlite3";

const sourcePath = path.resolve(process.env.CHANGEGRAPH_DB_PATH || "./data/changegraph.db");
const backupDirectory = path.resolve(process.env.CHANGEGRAPH_BACKUP_DIR || "./data/backups");

await fs.access(sourcePath);
await fs.mkdir(backupDirectory, { recursive: true });

const timestamp = new Date().toISOString().replaceAll(":", "-").replace(".", "-");
const backupPath = path.join(backupDirectory, `changegraph-${timestamp}.db`);
const source = new Database(sourcePath, { readonly: true, fileMustExist: true });
source.pragma("busy_timeout = 5000");

try {
  await source.backup(backupPath);
} finally {
  source.close();
}

const verification = new Database(backupPath, { readonly: true, fileMustExist: true });
try {
  const integrity = verification.prepare("PRAGMA integrity_check").get();
  const migration = verification.prepare("SELECT MAX(version) AS version FROM schema_migrations").get();
  if (integrity?.integrity_check !== "ok") throw new Error("SQLite integrity check failed for the backup.");
  console.log(JSON.stringify({ status: "created", source: sourcePath, backup: backupPath, migrationVersion: migration?.version ?? null }));
} finally {
  verification.close();
}
