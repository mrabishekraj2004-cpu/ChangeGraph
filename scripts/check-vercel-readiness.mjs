// Vercel Functions cannot share the durable SQLite file used by the web app and worker.
// DATABASE_URL currently validates a partial PostgreSQL migration; it does not
// switch all runtime repositories or provide a continuously running event worker.
if (process.env.VERCEL === "1") {
  console.error(
    "ChangeGraph Vercel build blocked: the web app and event worker still use " +
      "SQLite without shared durable storage. DATABASE_URL does not switch the " +
      "runtime to PostgreSQL. Complete the shared-storage and worker migration " +
      "before deploying. See docs/VERCEL_DEPLOYMENT.md.",
  );
  process.exitCode = 1;
}
