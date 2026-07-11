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
        UNIQUE (tenant_id, idempotency_key)
      );

      CREATE TABLE evaluation_steps (
        tenant_id TEXT NOT NULL,
        evaluation_id TEXT NOT NULL REFERENCES evaluation_runs(evaluation_id),
        step TEXT NOT NULL,
        status TEXT NOT NULL,
        detail TEXT,
        completed_at TEXT NOT NULL,
        PRIMARY KEY (evaluation_id, step)
      );
    `
  },
  {
    version: 2,
    name: "audit evidence and review records",
    sql: `
      CREATE TABLE evidence (
        tenant_id TEXT NOT NULL,
        evaluation_id TEXT NOT NULL REFERENCES evaluation_runs(evaluation_id),
        evidence_id TEXT NOT NULL,
        source_type TEXT NOT NULL,
        source_name TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        PRIMARY KEY (evaluation_id, evidence_id)
      );

      CREATE TABLE claims (
        claim_id INTEGER PRIMARY KEY AUTOINCREMENT,
        tenant_id TEXT NOT NULL,
        evaluation_id TEXT NOT NULL REFERENCES evaluation_runs(evaluation_id),
        kind TEXT NOT NULL CHECK (kind IN ('allowed', 'disallowed')),
        text TEXT NOT NULL
      );

      CREATE TABLE claim_evidence (
        claim_id INTEGER NOT NULL REFERENCES claims(claim_id),
        evaluation_id TEXT NOT NULL,
        evidence_id TEXT NOT NULL,
        PRIMARY KEY (claim_id, evidence_id),
        FOREIGN KEY (evaluation_id, evidence_id) REFERENCES evidence(evaluation_id, evidence_id)
      );

      CREATE TABLE writeback_plans (
        tenant_id TEXT NOT NULL,
        evaluation_id TEXT PRIMARY KEY REFERENCES evaluation_runs(evaluation_id),
        decision TEXT,
        reason TEXT
      );

      CREATE TABLE writeback_outcomes (
        tenant_id TEXT NOT NULL,
        evaluation_id TEXT PRIMARY KEY REFERENCES evaluation_runs(evaluation_id),
        status TEXT NOT NULL,
        reason TEXT NOT NULL,
        recorded_at TEXT NOT NULL
      );

      CREATE TABLE writeback_audit_records (
        audit_id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL REFERENCES tenants(tenant_id),
        evaluation_id TEXT NOT NULL REFERENCES evaluation_runs(evaluation_id),
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
        recorded_at TEXT NOT NULL
      );

      CREATE TABLE rollback_links (
        rollback_id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL REFERENCES tenants(tenant_id),
        evaluation_id TEXT NOT NULL REFERENCES evaluation_runs(evaluation_id),
        original_audit_id TEXT NOT NULL REFERENCES writeback_audit_records(audit_id),
        rollback_audit_id TEXT REFERENCES writeback_audit_records(audit_id),
        created_at TEXT NOT NULL
      );

      CREATE TABLE review_items (
        review_id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL REFERENCES tenants(tenant_id),
        evaluation_id TEXT NOT NULL REFERENCES evaluation_runs(evaluation_id),
        reason TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('open', 'resolved', 'dismissed')),
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        resolved_at TEXT
      );

      CREATE TABLE events (
        event_id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL REFERENCES tenants(tenant_id),
        evaluation_id TEXT REFERENCES evaluation_runs(evaluation_id),
        request_id TEXT,
        event_type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        occurred_at TEXT NOT NULL
      );

      CREATE INDEX evaluation_runs_tenant_completed ON evaluation_runs (tenant_id, completed_at);
      CREATE INDEX evaluation_runs_tenant_request ON evaluation_runs (tenant_id, request_id);
      CREATE INDEX events_tenant_occurred ON events (tenant_id, occurred_at);
      CREATE INDEX review_items_tenant_status ON review_items (tenant_id, status);

      CREATE TRIGGER writeback_audit_records_no_update
      BEFORE UPDATE ON writeback_audit_records BEGIN SELECT RAISE(ABORT, 'writeback audit records are append-only'); END;
      CREATE TRIGGER writeback_audit_records_no_delete
      BEFORE DELETE ON writeback_audit_records BEGIN SELECT RAISE(ABORT, 'writeback audit records are append-only'); END;
      CREATE TRIGGER events_no_update
      BEFORE UPDATE ON events BEGIN SELECT RAISE(ABORT, 'events are append-only'); END;
      CREATE TRIGGER events_no_delete
      BEFORE DELETE ON events BEGIN SELECT RAISE(ABORT, 'events are append-only'); END;
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
