import type { DatabaseSync } from "node:sqlite";

export type Migration = Readonly<{ version: number; name: string; sql: string }>;

export const migrations: readonly Migration[] = [
  {
    version: 1,
    name: "runtime foundation",
    sql: `
      CREATE TABLE tenants (
        tenant_id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE integrations (
        integration_id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL REFERENCES tenants(tenant_id),
        provider TEXT NOT NULL,
        external_account_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('active', 'disabled', 'error')),
        created_at TEXT NOT NULL,
        UNIQUE (tenant_id, provider, external_account_id)
      );

      CREATE TABLE config_versions (
        tenant_id TEXT NOT NULL REFERENCES tenants(tenant_id),
        version_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('draft', 'active', 'inactive')),
        created_by TEXT NOT NULL,
        created_at TEXT NOT NULL,
        config_json TEXT NOT NULL,
        PRIMARY KEY (tenant_id, version_id)
      );

      CREATE UNIQUE INDEX config_versions_one_active_per_tenant
      ON config_versions (tenant_id) WHERE status = 'active';

      CREATE TABLE evaluation_runs (
        evaluation_id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL REFERENCES tenants(tenant_id),
        request_id TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        lead_id TEXT NOT NULL,
        account_id TEXT,
        score_version TEXT NOT NULL,
        outcome_status TEXT NOT NULL CHECK (outcome_status IN ('complete', 'partial_failure')),
        packet_json TEXT NOT NULL,
        started_at TEXT NOT NULL,
        completed_at TEXT NOT NULL,
        retention_after TEXT,
        UNIQUE (tenant_id, idempotency_key),
        UNIQUE (tenant_id, evaluation_id),
        UNIQUE (tenant_id, evaluation_id, request_id, score_version),
        FOREIGN KEY (tenant_id, score_version) REFERENCES config_versions(tenant_id, version_id)
      );

      CREATE TABLE evaluation_steps (
        tenant_id TEXT NOT NULL,
        evaluation_id TEXT NOT NULL,
        step TEXT NOT NULL,
        status TEXT NOT NULL,
        detail TEXT,
        completed_at TEXT NOT NULL,
        PRIMARY KEY (evaluation_id, step),
        FOREIGN KEY (tenant_id, evaluation_id) REFERENCES evaluation_runs(tenant_id, evaluation_id)
      );
    `
  },
  {
    version: 2,
    name: "audit evidence and review records",
    sql: `
      CREATE TABLE evidence (
        tenant_id TEXT NOT NULL,
        evaluation_id TEXT NOT NULL,
        evidence_id TEXT NOT NULL,
        source_type TEXT NOT NULL,
        source_name TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        PRIMARY KEY (evaluation_id, evidence_id),
        UNIQUE (tenant_id, evaluation_id, evidence_id),
        FOREIGN KEY (tenant_id, evaluation_id) REFERENCES evaluation_runs(tenant_id, evaluation_id)
      );

      CREATE TABLE claims (
        claim_id INTEGER PRIMARY KEY AUTOINCREMENT,
        tenant_id TEXT NOT NULL,
        evaluation_id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('allowed', 'disallowed')),
        text TEXT NOT NULL,
        UNIQUE (tenant_id, evaluation_id, claim_id),
        FOREIGN KEY (tenant_id, evaluation_id) REFERENCES evaluation_runs(tenant_id, evaluation_id)
      );

      CREATE TABLE claim_evidence (
        tenant_id TEXT NOT NULL,
        claim_id INTEGER NOT NULL,
        evaluation_id TEXT NOT NULL,
        evidence_id TEXT NOT NULL,
        PRIMARY KEY (claim_id, evidence_id),
        FOREIGN KEY (tenant_id, evaluation_id, claim_id) REFERENCES claims(tenant_id, evaluation_id, claim_id),
        FOREIGN KEY (tenant_id, evaluation_id, evidence_id) REFERENCES evidence(tenant_id, evaluation_id, evidence_id)
      );

      CREATE TABLE writeback_plans (
        tenant_id TEXT NOT NULL,
        evaluation_id TEXT PRIMARY KEY,
        decision TEXT,
        reason TEXT,
        FOREIGN KEY (tenant_id, evaluation_id) REFERENCES evaluation_runs(tenant_id, evaluation_id)
      );

      CREATE TABLE writeback_outcomes (
        tenant_id TEXT NOT NULL,
        evaluation_id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        reason TEXT NOT NULL,
        recorded_at TEXT NOT NULL,
        FOREIGN KEY (tenant_id, evaluation_id) REFERENCES evaluation_runs(tenant_id, evaluation_id)
      );

      CREATE TABLE writeback_audit_records (
        audit_id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL REFERENCES tenants(tenant_id),
        evaluation_id TEXT NOT NULL,
        request_id TEXT NOT NULL,
        crm_object_type TEXT NOT NULL,
        crm_object_id TEXT NOT NULL,
        field_name TEXT NOT NULL,
        previous_value_json TEXT,
        new_value_json TEXT,
        source_name TEXT NOT NULL,
        source_ref TEXT NOT NULL,
        source_updated_at TEXT NOT NULL,
        confidence TEXT NOT NULL,
        outcome TEXT NOT NULL,
        reason TEXT NOT NULL,
        score_version TEXT NOT NULL,
        actor_type TEXT NOT NULL,
        recorded_at TEXT NOT NULL,
        UNIQUE (tenant_id, evaluation_id, audit_id),
        FOREIGN KEY (tenant_id, evaluation_id, request_id, score_version)
          REFERENCES evaluation_runs(tenant_id, evaluation_id, request_id, score_version)
      );

      CREATE TABLE rollback_links (
        rollback_id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL REFERENCES tenants(tenant_id),
        evaluation_id TEXT NOT NULL,
        original_audit_id TEXT NOT NULL,
        rollback_audit_id TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY (tenant_id, evaluation_id) REFERENCES evaluation_runs(tenant_id, evaluation_id),
        FOREIGN KEY (tenant_id, evaluation_id, original_audit_id) REFERENCES writeback_audit_records(tenant_id, evaluation_id, audit_id),
        FOREIGN KEY (tenant_id, evaluation_id, rollback_audit_id) REFERENCES writeback_audit_records(tenant_id, evaluation_id, audit_id)
      );

      CREATE TABLE review_items (
        review_id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL REFERENCES tenants(tenant_id),
        evaluation_id TEXT NOT NULL,
        reason TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('open', 'resolved', 'dismissed')),
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        resolved_at TEXT,
        FOREIGN KEY (tenant_id, evaluation_id) REFERENCES evaluation_runs(tenant_id, evaluation_id)
      );

      CREATE TABLE events (
        event_id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL REFERENCES tenants(tenant_id),
        evaluation_id TEXT,
        request_id TEXT,
        event_type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        occurred_at TEXT NOT NULL,
        FOREIGN KEY (tenant_id, evaluation_id) REFERENCES evaluation_runs(tenant_id, evaluation_id)
      );

      CREATE INDEX evaluation_runs_tenant_completed ON evaluation_runs (tenant_id, completed_at);
      CREATE INDEX evaluation_runs_tenant_request ON evaluation_runs (tenant_id, request_id);
      CREATE INDEX events_tenant_occurred ON events (tenant_id, occurred_at);
      CREATE INDEX review_items_tenant_status ON review_items (tenant_id, status);

      CREATE TRIGGER writeback_audit_records_no_update
      BEFORE UPDATE ON writeback_audit_records BEGIN SELECT RAISE(ABORT, 'writeback audit records are append-only'); END;
      CREATE TRIGGER writeback_audit_records_no_delete
      BEFORE DELETE ON writeback_audit_records BEGIN SELECT RAISE(ABORT, 'writeback audit records are append-only'); END;
      CREATE TRIGGER writeback_audit_records_no_duplicate
      BEFORE INSERT ON writeback_audit_records
      WHEN EXISTS (SELECT 1 FROM writeback_audit_records WHERE audit_id = NEW.audit_id)
      BEGIN SELECT RAISE(ABORT, 'writeback audit records are append-only'); END;
      CREATE TRIGGER events_no_update
      BEFORE UPDATE ON events BEGIN SELECT RAISE(ABORT, 'events are append-only'); END;
      CREATE TRIGGER events_no_delete
      BEFORE DELETE ON events BEGIN SELECT RAISE(ABORT, 'events are append-only'); END;
      CREATE TRIGGER events_no_duplicate
      BEFORE INSERT ON events
      WHEN EXISTS (SELECT 1 FROM events WHERE event_id = NEW.event_id)
      BEGIN SELECT RAISE(ABORT, 'events are append-only'); END;
    `
  },
  {
    version: 3,
    name: "pilot event idempotency and retention",
    sql: `
      ALTER TABLE events ADD COLUMN idempotency_key TEXT;
      UPDATE events SET idempotency_key = event_id;
      ALTER TABLE events ADD COLUMN retention_class TEXT NOT NULL DEFAULT 'pilot_analytics_12_months';
      CREATE UNIQUE INDEX events_tenant_idempotency ON events (tenant_id, idempotency_key);
    `
  },
  {
    version: 4,
    name: "grounding audit records",
    sql: `
      CREATE TABLE grounding_audit_records (
        grounding_audit_id INTEGER PRIMARY KEY AUTOINCREMENT,
        tenant_id TEXT NOT NULL,
        evaluation_id TEXT NOT NULL,
        prompt_version TEXT NOT NULL,
        model_id TEXT NOT NULL,
        allowed_claim_ids_json TEXT NOT NULL,
        evidence_ids_json TEXT NOT NULL,
        compiled_claims_json TEXT NOT NULL,
        hook_claim_ids_json TEXT NOT NULL,
        output_json TEXT NOT NULL,
        outcome TEXT NOT NULL CHECK (outcome IN ('validated', 'fallback')),
        failure TEXT CHECK (failure IN ('invalid_output', 'provider_failure')),
        recorded_at TEXT NOT NULL,
        CHECK (outcome = 'fallback' OR failure IS NULL),
        FOREIGN KEY (tenant_id, evaluation_id) REFERENCES evaluation_runs(tenant_id, evaluation_id)
      );

      CREATE INDEX grounding_audits_tenant_evaluation
      ON grounding_audit_records (tenant_id, evaluation_id);

      CREATE TRIGGER grounding_audit_records_no_update
      BEFORE UPDATE ON grounding_audit_records BEGIN SELECT RAISE(ABORT, 'grounding audit records are append-only'); END;
      CREATE TRIGGER grounding_audit_records_no_delete
      BEFORE DELETE ON grounding_audit_records BEGIN SELECT RAISE(ABORT, 'grounding audit records are append-only'); END;
      CREATE TRIGGER grounding_audit_records_no_duplicate
      BEFORE INSERT ON grounding_audit_records
      WHEN EXISTS (SELECT 1 FROM grounding_audit_records WHERE grounding_audit_id = NEW.grounding_audit_id)
      BEGIN SELECT RAISE(ABORT, 'grounding audit records are append-only'); END;
    `
  },
  {
    version: 5,
    name: "immutable rollback links",
    sql: `
      ALTER TABLE writeback_audit_records ADD COLUMN policy_version TEXT NOT NULL DEFAULT 'legacy';
      CREATE UNIQUE INDEX rollback_links_original_audit ON rollback_links (original_audit_id);
      CREATE TRIGGER rollback_links_no_update
      BEFORE UPDATE ON rollback_links BEGIN SELECT RAISE(ABORT, 'rollback links are append-only'); END;
      CREATE TRIGGER rollback_links_no_delete
      BEFORE DELETE ON rollback_links BEGIN SELECT RAISE(ABORT, 'rollback links are append-only'); END;
      CREATE TRIGGER rollback_links_no_duplicate
      BEFORE INSERT ON rollback_links
      WHEN EXISTS (SELECT 1 FROM rollback_links WHERE rollback_id = NEW.rollback_id)
      BEGIN SELECT RAISE(ABORT, 'rollback links are append-only'); END;
    `
  },
  {
    version: 6,
    name: "writeback audit actor identity",
    sql: `
      ALTER TABLE writeback_audit_records ADD COLUMN actor_id TEXT NOT NULL DEFAULT 'legacy';
    `
  },
  {
    version: 7,
    name: "request identity and pilot access controls",
    sql: `
      ALTER TABLE evaluation_runs ADD COLUMN assigned_rep_id TEXT;
      ALTER TABLE writeback_audit_records ADD COLUMN access_request_id TEXT;

      CREATE TABLE access_audit_records (
        access_audit_id INTEGER PRIMARY KEY AUTOINCREMENT,
        tenant_id TEXT NOT NULL REFERENCES tenants(tenant_id),
        request_id TEXT NOT NULL,
        actor_id TEXT NOT NULL,
        actor_role TEXT NOT NULL CHECK (actor_role IN ('revops_admin', 'rep', 'system', 'integration')),
        action TEXT NOT NULL,
        resource_type TEXT NOT NULL,
        resource_id TEXT NOT NULL,
        outcome TEXT NOT NULL CHECK (outcome IN ('allowed', 'denied')),
        recorded_at TEXT NOT NULL
      );

      CREATE INDEX access_audits_tenant_recorded ON access_audit_records (tenant_id, recorded_at);
      CREATE TRIGGER access_audit_records_no_update
      BEFORE UPDATE ON access_audit_records BEGIN SELECT RAISE(ABORT, 'access audit records are append-only'); END;
      CREATE TRIGGER access_audit_records_no_delete
      BEFORE DELETE ON access_audit_records BEGIN SELECT RAISE(ABORT, 'access audit records are append-only'); END;
      CREATE TRIGGER access_audit_records_no_duplicate
      BEFORE INSERT ON access_audit_records
      WHEN EXISTS (SELECT 1 FROM access_audit_records WHERE access_audit_id = NEW.access_audit_id)
      BEGIN SELECT RAISE(ABORT, 'access audit records are append-only'); END;
    `
  },
  {
    version: 8,
    name: "encrypted integration credentials and operations",
    sql: `
      ALTER TABLE integrations ADD COLUMN access_token_ciphertext TEXT;
      ALTER TABLE integrations ADD COLUMN refresh_token_ciphertext TEXT;
      ALTER TABLE integrations ADD COLUMN scopes_json TEXT NOT NULL DEFAULT '[]';
      ALTER TABLE integrations ADD COLUMN token_expires_at TEXT;
      ALTER TABLE integrations ADD COLUMN last_health_at TEXT;
      ALTER TABLE integrations ADD COLUMN last_error TEXT;
      ALTER TABLE integrations ADD COLUMN rate_limited_until TEXT;
      ALTER TABLE integrations ADD COLUMN revoked_at TEXT;

      UPDATE integrations SET status = 'disabled', last_error = 'oauth_reconnect_required'
      WHERE status = 'active' AND access_token_ciphertext IS NULL;
    `
  },
  {
    version: 9,
    name: "retention purge controls",
    sql: `
      ALTER TABLE evaluation_runs ADD COLUMN purged_at TEXT;
      UPDATE evaluation_runs
      SET retention_after = strftime('%Y-%m-%dT%H:%M:%fZ', completed_at, '+365 days')
      WHERE retention_after IS NULL;
      CREATE TABLE retention_job_guard (active INTEGER PRIMARY KEY CHECK (active = 1));

      DROP TRIGGER events_no_delete;
      CREATE TRIGGER events_no_delete
      BEFORE DELETE ON events
      WHEN OLD.retention_class = 'writeback_audit_24_months'
        OR NOT EXISTS (SELECT 1 FROM retention_job_guard WHERE active = 1)
      BEGIN SELECT RAISE(ABORT, 'events are append-only'); END;

      DROP TRIGGER grounding_audit_records_no_update;
      CREATE TRIGGER grounding_audit_records_no_update
      BEFORE UPDATE ON grounding_audit_records
      WHEN NOT EXISTS (SELECT 1 FROM retention_job_guard WHERE active = 1)
      BEGIN SELECT RAISE(ABORT, 'grounding audit records are append-only'); END;
    `
  },
  {
    version: 10,
    name: "access audit replacement guard",
    sql: `
      CREATE TRIGGER IF NOT EXISTS access_audit_records_no_duplicate
      BEFORE INSERT ON access_audit_records
      WHEN EXISTS (SELECT 1 FROM access_audit_records WHERE access_audit_id = NEW.access_audit_id)
      BEGIN SELECT RAISE(ABORT, 'access audit records are append-only'); END;
    `
  },
  {
    version: 11,
    name: "legacy security backfills",
    sql: `
      UPDATE integrations SET status = 'disabled', last_error = 'oauth_reconnect_required'
      WHERE status = 'active' AND access_token_ciphertext IS NULL;
      UPDATE evaluation_runs
      SET retention_after = strftime('%Y-%m-%dT%H:%M:%fZ', completed_at, '+365 days')
      WHERE retention_after IS NULL;
    `
  },
  {
    version: 12,
    name: "governance review and immutable config controls",
    sql: `
      ALTER TABLE review_items ADD COLUMN resolved_by TEXT;
      ALTER TABLE review_items ADD COLUMN resolution_note TEXT;

      CREATE TRIGGER config_versions_no_delete
      BEFORE DELETE ON config_versions BEGIN SELECT RAISE(ABORT, 'config versions are immutable'); END;
      CREATE TRIGGER config_versions_content_immutable
      BEFORE UPDATE ON config_versions
      WHEN OLD.tenant_id != NEW.tenant_id
        OR OLD.version_id != NEW.version_id
        OR OLD.created_by != NEW.created_by
        OR OLD.created_at != NEW.created_at
        OR OLD.config_json != NEW.config_json
      BEGIN SELECT RAISE(ABORT, 'config versions are immutable'); END;
    `
  }
];

export function migrateDatabase(database: DatabaseSync, available: readonly Migration[] = migrations, targetVersion = Math.max(...available.map(({ version }) => version))) {
  const versions = available.map(({ version }) => version);
  if (new Set(versions).size !== versions.length || versions.some((version) => !Number.isSafeInteger(version) || version < 1)) {
    throw new Error("Migration versions must be unique positive integers");
  }
  database.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
  `);

  const applied = new Set(
    (database.prepare("SELECT version FROM schema_migrations").all() as Array<{ version: number }>).map(({ version }) => version)
  );

  for (const migration of available.filter(({ version }) => version <= targetVersion).sort((left, right) => left.version - right.version)) {
    if (applied.has(migration.version)) continue;
    database.exec("BEGIN IMMEDIATE");
    try {
      database.exec(migration.sql);
      database.prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)")
        .run(migration.version, migration.name, new Date().toISOString());
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw new Error(`Migration ${migration.version} (${migration.name}) failed`, { cause: error });
    }
  }
}
