import type Database from "better-sqlite3";

type Migration = { version: number; name: string; sql?: string; apply?: (database: Database.Database) => void };

const migrations: Migration[] = [
  {
    version: 1,
    name: "domain-and-ingestion-foundation",
    sql: `
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS integrations (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        provider TEXT NOT NULL,
        status TEXT NOT NULL,
        display_name TEXT NOT NULL,
        config_json TEXT NOT NULL DEFAULT '{}',
        last_success_at TEXT,
        last_error_at TEXT,
        last_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (workspace_id, provider)
      );
      CREATE TABLE IF NOT EXISTS event_inbox (
        id TEXT PRIMARY KEY,
        workspace_id TEXT REFERENCES workspaces(id) ON DELETE CASCADE,
        source TEXT NOT NULL,
        event_type TEXT NOT NULL,
        schema_version INTEGER NOT NULL,
        external_id TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        headers_json TEXT NOT NULL DEFAULT '{}',
        status TEXT NOT NULL DEFAULT 'received',
        attempt_count INTEGER NOT NULL DEFAULT 0,
        next_attempt_at TEXT,
        received_at TEXT NOT NULL,
        processed_at TEXT,
        last_error TEXT,
        UNIQUE (source, idempotency_key)
      );
      CREATE INDEX IF NOT EXISTS event_inbox_pending_idx ON event_inbox(status, next_attempt_at);
      CREATE TABLE IF NOT EXISTS event_attempts (
        id TEXT PRIMARY KEY,
        event_id TEXT NOT NULL REFERENCES event_inbox(id) ON DELETE CASCADE,
        attempt INTEGER NOT NULL,
        status TEXT NOT NULL,
        error TEXT,
        started_at TEXT NOT NULL,
        finished_at TEXT
      );
      CREATE TABLE IF NOT EXISTS dead_letter_events (
        id TEXT PRIMARY KEY,
        event_id TEXT NOT NULL REFERENCES event_inbox(id) ON DELETE CASCADE,
        workspace_id TEXT REFERENCES workspaces(id) ON DELETE CASCADE,
        reason TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        attempts INTEGER NOT NULL,
        failed_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS telemetry_references (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        incident_id TEXT REFERENCES incidents(id) ON DELETE SET NULL,
        service_id TEXT REFERENCES services(id) ON DELETE SET NULL,
        signal_kind TEXT NOT NULL,
        external_ref TEXT NOT NULL,
        observed_at TEXT NOT NULL,
        summary TEXT NOT NULL,
        source_url TEXT,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE (workspace_id, signal_kind, external_ref)
      );
      CREATE TABLE IF NOT EXISTS hypotheses (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        incident_id TEXT NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        summary TEXT NOT NULL,
        status TEXT NOT NULL,
        confidence REAL NOT NULL,
        is_abstention INTEGER NOT NULL DEFAULT 0,
        created_by TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS hypothesis_evidence (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        hypothesis_id TEXT NOT NULL REFERENCES hypotheses(id) ON DELETE CASCADE,
        evidence_kind TEXT NOT NULL,
        evidence_ref TEXT NOT NULL,
        relationship TEXT NOT NULL,
        weight REAL NOT NULL,
        source_url TEXT,
        created_at TEXT NOT NULL,
        UNIQUE (hypothesis_id, evidence_kind, evidence_ref)
      );
      CREATE TABLE IF NOT EXISTS audit_events (
        id TEXT PRIMARY KEY,
        workspace_id TEXT REFERENCES workspaces(id) ON DELETE CASCADE,
        actor_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
        action TEXT NOT NULL,
        entity_type TEXT NOT NULL,
        entity_id TEXT,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS audit_events_workspace_idx ON audit_events(workspace_id, created_at);
      CREATE TABLE IF NOT EXISTS service_dependencies (
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        upstream_service_id TEXT NOT NULL REFERENCES services(id) ON DELETE CASCADE,
        downstream_service_id TEXT NOT NULL REFERENCES services(id) ON DELETE CASCADE,
        dependency_kind TEXT NOT NULL DEFAULT 'runtime',
        created_at TEXT NOT NULL,
        PRIMARY KEY (workspace_id, upstream_service_id, downstream_service_id)
      );
    `,
  },
  {
    version: 2,
    name: "external-source-identifiers",
    apply(database) {
      const additions: Array<[string, string]> = [
        ["services", "provider TEXT"],
        ["services", "external_id TEXT"],
        ["changes", "provider TEXT"],
        ["changes", "external_id TEXT"],
        ["deployments", "provider TEXT"],
        ["deployments", "external_id TEXT"],
      ];
      for (const [table, definition] of additions) {
        const column = definition.split(" ")[0];
        const exists = (database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).some((item) => item.name === column);
        if (!exists) database.exec(`ALTER TABLE ${table} ADD COLUMN ${definition}`);
      }
    },
  },
  {
    version: 3,
    name: "service-graph-relationships",
    sql: `
      CREATE TABLE IF NOT EXISTS service_dependencies (
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        upstream_service_id TEXT NOT NULL REFERENCES services(id) ON DELETE CASCADE,
        downstream_service_id TEXT NOT NULL REFERENCES services(id) ON DELETE CASCADE,
        dependency_kind TEXT NOT NULL DEFAULT 'runtime',
        created_at TEXT NOT NULL,
        PRIMARY KEY (workspace_id, upstream_service_id, downstream_service_id)
      );
      CREATE INDEX IF NOT EXISTS service_dependencies_downstream_idx ON service_dependencies(workspace_id, downstream_service_id);
    `,
  },
  {
    version: 4,
    name: "external-event-lookup-indexes",
    sql: `
      CREATE UNIQUE INDEX IF NOT EXISTS changes_external_id_idx ON changes(workspace_id, provider, external_id);
      CREATE UNIQUE INDEX IF NOT EXISTS deployments_external_id_idx ON deployments(workspace_id, provider, external_id);
      CREATE INDEX IF NOT EXISTS telemetry_references_incident_idx ON telemetry_references(workspace_id, incident_id, observed_at);
    `,
  },
  {
    version: 5,
    name: "detection-agent-evaluation-foundation",
    sql: `
      CREATE TABLE IF NOT EXISTS service_health_baselines (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        service_id TEXT NOT NULL REFERENCES services(id) ON DELETE CASCADE,
        metric_name TEXT NOT NULL,
        metric_kind TEXT NOT NULL,
        baseline_value REAL NOT NULL,
        baseline_unit TEXT,
        sample_count INTEGER NOT NULL,
        window_start TEXT NOT NULL,
        window_end TEXT NOT NULL,
        source TEXT NOT NULL,
        computed_at TEXT NOT NULL,
        UNIQUE (workspace_id, service_id, metric_name)
      );
      CREATE TABLE IF NOT EXISTS health_anomalies (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        service_id TEXT NOT NULL REFERENCES services(id) ON DELETE CASCADE,
        incident_id TEXT REFERENCES incidents(id) ON DELETE SET NULL,
        signal_id TEXT NOT NULL REFERENCES signals(id) ON DELETE CASCADE,
        metric_name TEXT NOT NULL,
        metric_kind TEXT NOT NULL,
        observed_value REAL NOT NULL,
        baseline_value REAL NOT NULL,
        delta_ratio REAL NOT NULL,
        threshold REAL NOT NULL,
        severity TEXT NOT NULL,
        explanation TEXT NOT NULL,
        observed_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE (workspace_id, signal_id, metric_name)
      );
      CREATE INDEX IF NOT EXISTS health_anomalies_incident_idx ON health_anomalies(workspace_id, incident_id, observed_at);
      CREATE TABLE IF NOT EXISTS runbooks (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        service_id TEXT REFERENCES services(id) ON DELETE SET NULL,
        slug TEXT NOT NULL,
        title TEXT NOT NULL,
        summary TEXT NOT NULL,
        url TEXT,
        content TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (workspace_id, slug)
      );
      CREATE TABLE IF NOT EXISTS agent_runs (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        incident_id TEXT NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
        agent_type TEXT NOT NULL,
        status TEXT NOT NULL,
        model TEXT NOT NULL,
        latency_ms INTEGER,
        input_tokens INTEGER,
        output_tokens INTEGER,
        total_tokens INTEGER,
        output_json TEXT,
        error TEXT,
        created_at TEXT NOT NULL,
        completed_at TEXT
      );
      CREATE INDEX IF NOT EXISTS agent_runs_incident_idx ON agent_runs(workspace_id, incident_id, created_at);
      CREATE TABLE IF NOT EXISTS agent_tool_calls (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
        tool_name TEXT NOT NULL,
        input_json TEXT NOT NULL,
        output_json TEXT,
        status TEXT NOT NULL,
        latency_ms INTEGER,
        error TEXT,
        evidence_refs_json TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS agent_tool_calls_run_idx ON agent_tool_calls(workspace_id, run_id, created_at);
      CREATE TABLE IF NOT EXISTS evaluation_runs (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        evaluation_id TEXT NOT NULL REFERENCES evaluations(id) ON DELETE CASCADE,
        status TEXT NOT NULL,
        total_cases INTEGER NOT NULL,
        top3_accuracy REAL,
        evidence_coverage REAL,
        detection_lag_ms REAL,
        abstention_accuracy REAL,
        details_json TEXT NOT NULL DEFAULT '{}',
        started_at TEXT NOT NULL,
        completed_at TEXT
      );
      CREATE INDEX IF NOT EXISTS evaluation_runs_workspace_idx ON evaluation_runs(workspace_id, evaluation_id, started_at);
      CREATE TABLE IF NOT EXISTS evaluation_case_results (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        evaluation_run_id TEXT NOT NULL REFERENCES evaluation_runs(id) ON DELETE CASCADE,
        evaluation_case_id TEXT NOT NULL REFERENCES evaluation_cases(id) ON DELETE CASCADE,
        top3_hit INTEGER NOT NULL,
        evidence_coverage REAL NOT NULL,
        detection_lag_ms REAL,
        abstention_expected INTEGER NOT NULL,
        abstention_correct INTEGER NOT NULL,
        predicted_json TEXT NOT NULL,
        evidence_refs_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `,
    apply(database) {
      const additions: Array<[string, string]> = [
        ["hypotheses", "rank INTEGER NOT NULL DEFAULT 1"],
        ["hypotheses", "factors_json TEXT NOT NULL DEFAULT '[]'"],
        ["hypotheses", "abstention_reason TEXT"],
        ["evaluation_cases", "expected_abstention INTEGER NOT NULL DEFAULT 0"],
      ];
      for (const [table, definition] of additions) {
        const column = definition.split(" ")[0];
        const exists = (database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).some((item) => item.name === column);
        if (!exists) database.exec(`ALTER TABLE ${table} ADD COLUMN ${definition}`);
      }
    },
  },
  {
    version: 6,
    name: "event-processing-leases",
    apply(database) {
      const additions: Array<[string, string]> = [
        ["event_inbox", "processing_started_at TEXT"],
        ["event_inbox", "processing_worker_id TEXT"],
      ];
      for (const [table, definition] of additions) {
        const column = definition.split(" ")[0];
        const exists = (database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).some((item) => item.name === column);
        if (!exists) database.exec(`ALTER TABLE ${table} ADD COLUMN ${definition}`);
      }
      database.exec("CREATE INDEX IF NOT EXISTS event_inbox_processing_idx ON event_inbox(status, processing_started_at)");
    },
  },
  {
    version: 7,
    name: "worker-health-heartbeats",
    sql: `
      CREATE TABLE IF NOT EXISTS worker_heartbeats (
        worker_name TEXT PRIMARY KEY,
        last_seen_at TEXT NOT NULL,
        last_batch_size INTEGER NOT NULL DEFAULT 0,
        last_processed_count INTEGER NOT NULL DEFAULT 0,
        last_failed_count INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        updated_at TEXT NOT NULL
      );
    `,
  },
  {
    version: 8,
    name: "shared-rate-limit-buckets",
    sql: `
      CREATE TABLE IF NOT EXISTS rate_limit_buckets (
        bucket_key TEXT PRIMARY KEY,
        count INTEGER NOT NULL,
        reset_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS rate_limit_buckets_reset_idx ON rate_limit_buckets(reset_at);
    `,
  },
];

export function runMigrations(database: Database.Database) {
  database.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)");
  const applied = new Set((database.prepare("SELECT version FROM schema_migrations").all() as Array<{ version: number }>).map((row) => row.version));
  for (const migration of migrations) {
    if (applied.has(migration.version)) continue;
    const apply = database.transaction(() => {
      if (migration.sql) database.exec(migration.sql);
      migration.apply?.(database);
      database.prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)").run(migration.version, migration.name, new Date().toISOString());
    });
    apply();
  }
}

export const currentMigrationVersion = migrations.at(-1)?.version ?? 0;
