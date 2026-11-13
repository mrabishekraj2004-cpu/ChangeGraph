/** PostgreSQL migration 2: product, ingestion, agent, evaluation, and operations data. */
export function postgresDomainSchemaSql(schema: string) {
  return `
    DO $changegraph_migration$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'sessions_workspace_user_fk'
          AND conrelid = '${schema}.sessions'::regclass
      ) THEN
        ALTER TABLE ${schema}.sessions
          ADD CONSTRAINT sessions_workspace_user_fk
          FOREIGN KEY (workspace_id, user_id)
          REFERENCES ${schema}.memberships(workspace_id, user_id)
          ON DELETE CASCADE;
      END IF;
    END
    $changegraph_migration$;

    CREATE TABLE IF NOT EXISTS ${schema}.services (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL REFERENCES ${schema}.workspaces(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      slug TEXT NOT NULL,
      owner TEXT NOT NULL,
      status TEXT NOT NULL,
      health_score INTEGER NOT NULL,
      last_deploy_at TIMESTAMPTZ,
      provider TEXT,
      external_id TEXT,
      UNIQUE (workspace_id, id),
      UNIQUE (workspace_id, slug)
    );
    CREATE TABLE IF NOT EXISTS ${schema}.changes (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL REFERENCES ${schema}.workspaces(id) ON DELETE CASCADE,
      sha TEXT NOT NULL,
      title TEXT NOT NULL,
      author TEXT NOT NULL,
      repository TEXT NOT NULL,
      url TEXT,
      risk_label TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL,
      provider TEXT,
      external_id TEXT,
      UNIQUE (workspace_id, id),
      UNIQUE (workspace_id, sha)
    );
    CREATE TABLE IF NOT EXISTS ${schema}.deployments (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL REFERENCES ${schema}.workspaces(id) ON DELETE CASCADE,
      service_id TEXT NOT NULL,
      change_id TEXT NOT NULL,
      version TEXT NOT NULL,
      environment TEXT NOT NULL,
      status TEXT NOT NULL,
      started_at TIMESTAMPTZ NOT NULL,
      completed_at TIMESTAMPTZ,
      url TEXT,
      provider TEXT,
      external_id TEXT,
      UNIQUE (workspace_id, id),
      FOREIGN KEY (workspace_id, service_id) REFERENCES ${schema}.services(workspace_id, id) ON DELETE CASCADE,
      FOREIGN KEY (workspace_id, change_id) REFERENCES ${schema}.changes(workspace_id, id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS ${schema}.incidents (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL REFERENCES ${schema}.workspaces(id) ON DELETE CASCADE,
      key TEXT NOT NULL,
      title TEXT NOT NULL,
      service_id TEXT NOT NULL,
      severity TEXT NOT NULL,
      status TEXT NOT NULL,
      started_at TIMESTAMPTZ NOT NULL,
      detected_at TIMESTAMPTZ NOT NULL,
      summary TEXT NOT NULL,
      impact TEXT NOT NULL,
      UNIQUE (workspace_id, id),
      UNIQUE (workspace_id, key),
      FOREIGN KEY (workspace_id, service_id) REFERENCES ${schema}.services(workspace_id, id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS ${schema}.timeline_events (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      incident_id TEXT NOT NULL,
      occurred_at TIMESTAMPTZ NOT NULL,
      type TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      source_url TEXT,
      evidence_kind TEXT NOT NULL,
      evidence_ref TEXT NOT NULL,
      FOREIGN KEY (workspace_id, incident_id) REFERENCES ${schema}.incidents(workspace_id, id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS ${schema}.investigations (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      incident_id TEXT NOT NULL,
      status TEXT NOT NULL,
      confidence DOUBLE PRECISION NOT NULL,
      summary TEXT NOT NULL,
      evidence_json JSONB NOT NULL,
      tool_calls_json JSONB NOT NULL,
      next_checks_json JSONB NOT NULL,
      model TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL,
      FOREIGN KEY (workspace_id, incident_id) REFERENCES ${schema}.incidents(workspace_id, id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS ${schema}.signals (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL REFERENCES ${schema}.workspaces(id) ON DELETE CASCADE,
      incident_id TEXT,
      kind TEXT NOT NULL,
      service_name TEXT NOT NULL,
      observed_at TIMESTAMPTZ NOT NULL,
      payload_json JSONB NOT NULL,
      source TEXT NOT NULL,
      UNIQUE (workspace_id, id),
      FOREIGN KEY (workspace_id, incident_id) REFERENCES ${schema}.incidents(workspace_id, id) ON DELETE SET NULL (incident_id)
    );
    CREATE TABLE IF NOT EXISTS ${schema}.evaluations (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL REFERENCES ${schema}.workspaces(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      description TEXT NOT NULL,
      total_cases INTEGER NOT NULL,
      pass_rate DOUBLE PRECISION NOT NULL,
      last_run_at TIMESTAMPTZ,
      UNIQUE (workspace_id, id)
    );
    CREATE TABLE IF NOT EXISTS ${schema}.evaluation_cases (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      evaluation_id TEXT NOT NULL,
      incident_key TEXT NOT NULL,
      expected_cause TEXT NOT NULL,
      status TEXT NOT NULL,
      confidence DOUBLE PRECISION NOT NULL,
      expected_abstention BOOLEAN NOT NULL DEFAULT FALSE,
      UNIQUE (workspace_id, id),
      FOREIGN KEY (workspace_id, evaluation_id) REFERENCES ${schema}.evaluations(workspace_id, id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS ${schema}.integrations (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL REFERENCES ${schema}.workspaces(id) ON DELETE CASCADE,
      provider TEXT NOT NULL,
      status TEXT NOT NULL,
      display_name TEXT NOT NULL,
      config_json JSONB NOT NULL DEFAULT '{}'::jsonb,
      last_success_at TIMESTAMPTZ,
      last_error_at TIMESTAMPTZ,
      last_error TEXT,
      created_at TIMESTAMPTZ NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL,
      UNIQUE (workspace_id, provider)
    );
    CREATE TABLE IF NOT EXISTS ${schema}.event_inbox (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL REFERENCES ${schema}.workspaces(id) ON DELETE CASCADE,
      source TEXT NOT NULL,
      event_type TEXT NOT NULL,
      schema_version INTEGER NOT NULL,
      external_id TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      payload_json JSONB NOT NULL,
      headers_json JSONB NOT NULL DEFAULT '{}'::jsonb,
      status TEXT NOT NULL DEFAULT 'received',
      attempt_count INTEGER NOT NULL DEFAULT 0,
      next_attempt_at TIMESTAMPTZ,
      received_at TIMESTAMPTZ NOT NULL,
      processed_at TIMESTAMPTZ,
      last_error TEXT,
      processing_started_at TIMESTAMPTZ,
      processing_worker_id TEXT,
      UNIQUE (workspace_id, source, idempotency_key),
      UNIQUE (workspace_id, id)
    );
    CREATE TABLE IF NOT EXISTS ${schema}.event_attempts (
      id TEXT PRIMARY KEY,
      event_id TEXT NOT NULL REFERENCES ${schema}.event_inbox(id) ON DELETE CASCADE,
      attempt INTEGER NOT NULL,
      status TEXT NOT NULL,
      error TEXT,
      started_at TIMESTAMPTZ NOT NULL,
      finished_at TIMESTAMPTZ
    );
    CREATE TABLE IF NOT EXISTS ${schema}.dead_letter_events (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      event_id TEXT NOT NULL,
      reason TEXT NOT NULL,
      payload_json JSONB NOT NULL,
      attempts INTEGER NOT NULL,
      failed_at TIMESTAMPTZ NOT NULL,
      FOREIGN KEY (workspace_id, event_id) REFERENCES ${schema}.event_inbox(workspace_id, id) ON DELETE CASCADE,
      UNIQUE (event_id)
    );
    CREATE TABLE IF NOT EXISTS ${schema}.telemetry_references (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL REFERENCES ${schema}.workspaces(id) ON DELETE CASCADE,
      incident_id TEXT,
      service_id TEXT,
      signal_kind TEXT NOT NULL,
      external_ref TEXT NOT NULL,
      observed_at TIMESTAMPTZ NOT NULL,
      summary TEXT NOT NULL,
      source_url TEXT,
      payload_json JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL,
      UNIQUE (workspace_id, signal_kind, external_ref),
      FOREIGN KEY (workspace_id, incident_id) REFERENCES ${schema}.incidents(workspace_id, id) ON DELETE SET NULL (incident_id),
      FOREIGN KEY (workspace_id, service_id) REFERENCES ${schema}.services(workspace_id, id) ON DELETE SET NULL (service_id)
    );
    CREATE TABLE IF NOT EXISTS ${schema}.hypotheses (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL REFERENCES ${schema}.workspaces(id) ON DELETE CASCADE,
      incident_id TEXT NOT NULL,
      title TEXT NOT NULL,
      summary TEXT NOT NULL,
      status TEXT NOT NULL,
      confidence DOUBLE PRECISION NOT NULL,
      is_abstention BOOLEAN NOT NULL DEFAULT FALSE,
      created_by TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL,
      rank INTEGER NOT NULL DEFAULT 1,
      factors_json JSONB NOT NULL DEFAULT '[]'::jsonb,
      abstention_reason TEXT,
      UNIQUE (workspace_id, id),
      FOREIGN KEY (workspace_id, incident_id) REFERENCES ${schema}.incidents(workspace_id, id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS ${schema}.hypothesis_evidence (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      hypothesis_id TEXT NOT NULL,
      evidence_kind TEXT NOT NULL,
      evidence_ref TEXT NOT NULL,
      relationship TEXT NOT NULL,
      weight DOUBLE PRECISION NOT NULL,
      source_url TEXT,
      created_at TIMESTAMPTZ NOT NULL,
      UNIQUE (hypothesis_id, evidence_kind, evidence_ref),
      FOREIGN KEY (workspace_id, hypothesis_id) REFERENCES ${schema}.hypotheses(workspace_id, id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS ${schema}.service_dependencies (
      workspace_id TEXT NOT NULL REFERENCES ${schema}.workspaces(id) ON DELETE CASCADE,
      upstream_service_id TEXT NOT NULL,
      downstream_service_id TEXT NOT NULL,
      dependency_kind TEXT NOT NULL DEFAULT 'runtime',
      created_at TIMESTAMPTZ NOT NULL,
      PRIMARY KEY (workspace_id, upstream_service_id, downstream_service_id),
      FOREIGN KEY (workspace_id, upstream_service_id) REFERENCES ${schema}.services(workspace_id, id) ON DELETE CASCADE,
      FOREIGN KEY (workspace_id, downstream_service_id) REFERENCES ${schema}.services(workspace_id, id) ON DELETE CASCADE,
      CHECK (upstream_service_id <> downstream_service_id)
    );
    CREATE TABLE IF NOT EXISTS ${schema}.service_health_baselines (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL REFERENCES ${schema}.workspaces(id) ON DELETE CASCADE,
      service_id TEXT NOT NULL,
      metric_name TEXT NOT NULL,
      metric_kind TEXT NOT NULL,
      baseline_value DOUBLE PRECISION NOT NULL,
      baseline_unit TEXT,
      sample_count INTEGER NOT NULL,
      window_start TIMESTAMPTZ NOT NULL,
      window_end TIMESTAMPTZ NOT NULL,
      source TEXT NOT NULL,
      computed_at TIMESTAMPTZ NOT NULL,
      UNIQUE (workspace_id, service_id, metric_name),
      FOREIGN KEY (workspace_id, service_id) REFERENCES ${schema}.services(workspace_id, id) ON DELETE CASCADE,
      CHECK (sample_count >= 0),
      CHECK (window_end >= window_start)
    );
    CREATE TABLE IF NOT EXISTS ${schema}.health_anomalies (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL REFERENCES ${schema}.workspaces(id) ON DELETE CASCADE,
      service_id TEXT NOT NULL,
      incident_id TEXT,
      signal_id TEXT NOT NULL,
      metric_name TEXT NOT NULL,
      metric_kind TEXT NOT NULL,
      observed_value DOUBLE PRECISION NOT NULL,
      baseline_value DOUBLE PRECISION NOT NULL,
      delta_ratio DOUBLE PRECISION NOT NULL,
      threshold DOUBLE PRECISION NOT NULL,
      severity TEXT NOT NULL,
      explanation TEXT NOT NULL,
      observed_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL,
      UNIQUE (workspace_id, signal_id, metric_name),
      FOREIGN KEY (workspace_id, service_id) REFERENCES ${schema}.services(workspace_id, id) ON DELETE CASCADE,
      FOREIGN KEY (workspace_id, incident_id) REFERENCES ${schema}.incidents(workspace_id, id) ON DELETE SET NULL (incident_id),
      FOREIGN KEY (workspace_id, signal_id) REFERENCES ${schema}.signals(workspace_id, id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS ${schema}.runbooks (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL REFERENCES ${schema}.workspaces(id) ON DELETE CASCADE,
      service_id TEXT,
      slug TEXT NOT NULL,
      title TEXT NOT NULL,
      summary TEXT NOT NULL,
      url TEXT,
      content TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL,
      UNIQUE (workspace_id, slug),
      FOREIGN KEY (workspace_id, service_id) REFERENCES ${schema}.services(workspace_id, id) ON DELETE SET NULL (service_id)
    );
    CREATE TABLE IF NOT EXISTS ${schema}.agent_runs (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL REFERENCES ${schema}.workspaces(id) ON DELETE CASCADE,
      incident_id TEXT NOT NULL,
      agent_type TEXT NOT NULL,
      status TEXT NOT NULL,
      model TEXT NOT NULL,
      latency_ms INTEGER,
      input_tokens INTEGER,
      output_tokens INTEGER,
      total_tokens INTEGER,
      output_json JSONB,
      error TEXT,
      created_at TIMESTAMPTZ NOT NULL,
      completed_at TIMESTAMPTZ,
      UNIQUE (workspace_id, id),
      FOREIGN KEY (workspace_id, incident_id) REFERENCES ${schema}.incidents(workspace_id, id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS ${schema}.agent_tool_calls (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      input_json JSONB NOT NULL,
      output_json JSONB,
      status TEXT NOT NULL,
      latency_ms INTEGER,
      error TEXT,
      evidence_refs_json JSONB NOT NULL DEFAULT '[]'::jsonb,
      created_at TIMESTAMPTZ NOT NULL,
      FOREIGN KEY (workspace_id, run_id) REFERENCES ${schema}.agent_runs(workspace_id, id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS ${schema}.evaluation_runs (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      evaluation_id TEXT NOT NULL,
      status TEXT NOT NULL,
      total_cases INTEGER NOT NULL,
      top3_accuracy DOUBLE PRECISION,
      evidence_coverage DOUBLE PRECISION,
      detection_lag_ms DOUBLE PRECISION,
      abstention_accuracy DOUBLE PRECISION,
      details_json JSONB NOT NULL DEFAULT '{}'::jsonb,
      started_at TIMESTAMPTZ NOT NULL,
      completed_at TIMESTAMPTZ,
      UNIQUE (workspace_id, id),
      FOREIGN KEY (workspace_id, evaluation_id) REFERENCES ${schema}.evaluations(workspace_id, id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS ${schema}.evaluation_case_results (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      evaluation_run_id TEXT NOT NULL,
      evaluation_case_id TEXT NOT NULL,
      top3_hit BOOLEAN NOT NULL,
      evidence_coverage DOUBLE PRECISION NOT NULL,
      detection_lag_ms DOUBLE PRECISION,
      abstention_expected BOOLEAN NOT NULL,
      abstention_correct BOOLEAN NOT NULL,
      predicted_json JSONB NOT NULL,
      evidence_refs_json JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL,
      FOREIGN KEY (workspace_id, evaluation_run_id) REFERENCES ${schema}.evaluation_runs(workspace_id, id) ON DELETE CASCADE,
      FOREIGN KEY (workspace_id, evaluation_case_id) REFERENCES ${schema}.evaluation_cases(workspace_id, id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS ${schema}.worker_heartbeats (
      worker_name TEXT PRIMARY KEY,
      last_seen_at TIMESTAMPTZ NOT NULL,
      last_batch_size INTEGER NOT NULL DEFAULT 0,
      last_processed_count INTEGER NOT NULL DEFAULT 0,
      last_failed_count INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      updated_at TIMESTAMPTZ NOT NULL
    );
    CREATE TABLE IF NOT EXISTS ${schema}.rate_limit_buckets (
      bucket_key TEXT PRIMARY KEY,
      count INTEGER NOT NULL,
      reset_at BIGINT NOT NULL,
      updated_at BIGINT NOT NULL
    );

    CREATE UNIQUE INDEX IF NOT EXISTS services_external_id_idx ON ${schema}.services(workspace_id, provider, external_id);
    CREATE UNIQUE INDEX IF NOT EXISTS changes_external_id_idx ON ${schema}.changes(workspace_id, provider, external_id);
    CREATE UNIQUE INDEX IF NOT EXISTS deployments_external_id_idx ON ${schema}.deployments(workspace_id, provider, external_id);
    CREATE INDEX IF NOT EXISTS services_workspace_name_idx ON ${schema}.services(workspace_id, name);
    CREATE INDEX IF NOT EXISTS changes_workspace_created_idx ON ${schema}.changes(workspace_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS deployments_workspace_started_idx ON ${schema}.deployments(workspace_id, started_at DESC);
    CREATE INDEX IF NOT EXISTS incidents_workspace_detected_idx ON ${schema}.incidents(workspace_id, detected_at DESC);
    CREATE INDEX IF NOT EXISTS timeline_events_incident_time_idx ON ${schema}.timeline_events(workspace_id, incident_id, occurred_at);
    CREATE INDEX IF NOT EXISTS signals_service_time_idx ON ${schema}.signals(workspace_id, service_name, observed_at DESC);
    CREATE INDEX IF NOT EXISTS event_inbox_pending_idx ON ${schema}.event_inbox(status, next_attempt_at);
    CREATE INDEX IF NOT EXISTS event_inbox_processing_idx ON ${schema}.event_inbox(status, processing_started_at);
    CREATE INDEX IF NOT EXISTS event_attempts_event_idx ON ${schema}.event_attempts(event_id, attempt);
    CREATE INDEX IF NOT EXISTS dead_letter_workspace_idx ON ${schema}.dead_letter_events(workspace_id, failed_at DESC);
    CREATE INDEX IF NOT EXISTS telemetry_references_incident_idx ON ${schema}.telemetry_references(workspace_id, incident_id, observed_at);
    CREATE INDEX IF NOT EXISTS hypotheses_incident_rank_idx ON ${schema}.hypotheses(workspace_id, incident_id, rank);
    CREATE INDEX IF NOT EXISTS service_dependencies_downstream_idx ON ${schema}.service_dependencies(workspace_id, downstream_service_id);
    CREATE INDEX IF NOT EXISTS health_anomalies_incident_idx ON ${schema}.health_anomalies(workspace_id, incident_id, observed_at);
    CREATE INDEX IF NOT EXISTS agent_runs_incident_idx ON ${schema}.agent_runs(workspace_id, incident_id, created_at);
    CREATE INDEX IF NOT EXISTS agent_tool_calls_run_idx ON ${schema}.agent_tool_calls(workspace_id, run_id, created_at);
    CREATE INDEX IF NOT EXISTS evaluation_runs_workspace_idx ON ${schema}.evaluation_runs(workspace_id, evaluation_id, started_at);
    CREATE INDEX IF NOT EXISTS rate_limit_buckets_reset_idx ON ${schema}.rate_limit_buckets(reset_at);
  `;
}
