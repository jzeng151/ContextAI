import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { assertConfigVersion, type ScoringConfigVersion } from "./config.ts";
import { assertLeadPacket, type Evidence, type LeadPacket } from "./contextai.ts";
import { migrateDatabase } from "./migrations.ts";

export type EvaluationOutcome = "complete" | "partial_failure";

type EvaluationInput = Readonly<{
  tenantId: string;
  idempotencyKey: string;
  packet: LeadPacket;
  retentionAfter?: string;
}>;

type AuditRecord = Readonly<{
  auditId?: string;
  tenantId: string;
  evaluationId: string;
  requestId: string;
  crmObjectType: string;
  crmObjectId: string;
  fieldName: string;
  previousValue?: unknown;
  newValue?: unknown;
  sourceName: string;
  sourceRef: string;
  sourceUpdatedAt: string;
  confidence: string;
  outcome: string;
  reason: string;
  scoreVersion: string;
  actorType: string;
  recordedAt?: string;
}>;

type EventRecord = Readonly<{
  eventId?: string;
  tenantId: string;
  evaluationId?: string;
  requestId?: string;
  eventType: string;
  payload: unknown;
  occurredAt?: string;
}>;

const nonEmpty = (value: string, name: string) => {
  if (!value.trim()) throw new Error(`${name} is required`);
  return value;
};
const json = (value: unknown) => {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new Error("value must be JSON serializable");
  return serialized;
};
const parse = <T>(value: string) => JSON.parse(value) as T;
const failedStatuses = new Set(["unavailable", "timeout", "rate_limited", "invalid_result"]);

export const createEvaluationIdentifiers = (requestId = randomUUID()) => ({
  requestId: nonEmpty(requestId, "requestId"),
  evaluationId: randomUUID()
});

const evidenceFrom = (packet: LeadPacket): Evidence[] => [
  ...packet.crm_context.evidence,
  ...packet.enrichment_fields.evidence,
  ...packet.intent_signals.evidence,
  ...packet.engagement_signals.evidence,
  ...packet.public_signals.flatMap(({ evidence }) => evidence),
  ...packet.validation_evidence
];

export class RuntimeStore {
  readonly database: DatabaseSync;

  constructor(path = process.env.DATABASE_PATH ?? ".contextai/contextai.sqlite", targetVersion?: number) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.database = new DatabaseSync(path);
    this.database.exec("PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL;");
    migrateDatabase(this.database, undefined, targetVersion);
  }

  close() {
    this.database.close();
  }

  saveTenant(tenantId: string, name: string) {
    this.database.prepare("INSERT OR IGNORE INTO tenants (tenant_id, name, created_at) VALUES (?, ?, ?)")
      .run(nonEmpty(tenantId, "tenantId"), nonEmpty(name, "tenant name"), new Date().toISOString());
  }

  saveIntegration(input: Readonly<{ integrationId: string; tenantId: string; provider: string; externalAccountId: string; status: "active" | "disabled" | "error" }>) {
    this.database.prepare(`
      INSERT INTO integrations (integration_id, tenant_id, provider, external_account_id, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(input.integrationId, input.tenantId, input.provider, input.externalAccountId, input.status, new Date().toISOString());
  }

  saveConfigVersion(tenantId: string, version: ScoringConfigVersion) {
    assertConfigVersion(version);
    this.database.prepare(`
      INSERT INTO config_versions (tenant_id, version_id, status, created_by, created_at, config_json)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(tenantId, version.id, version.status, version.author, version.createdAt, json(version));
  }

  saveEvaluation(input: EvaluationInput): Readonly<{ created: boolean; evaluationId: string }> {
    const { tenantId, idempotencyKey, packet } = input;
    assertLeadPacket(packet);
    nonEmpty(tenantId, "tenantId");
    nonEmpty(idempotencyKey, "idempotencyKey");
    if (input.retentionAfter !== undefined && !Number.isFinite(Date.parse(input.retentionAfter))) {
      throw new Error("retentionAfter must be an ISO date");
    }
    const outcome: EvaluationOutcome = Object.values(packet.tool_status).some(({ status }) => failedStatuses.has(status))
      ? "partial_failure"
      : "complete";

    this.database.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.database.prepare(`
        SELECT evaluation_id, request_id FROM evaluation_runs WHERE tenant_id = ? AND idempotency_key = ?
      `).get(tenantId, idempotencyKey) as { evaluation_id: string; request_id: string } | undefined;
      if (existing) {
        if (existing.evaluation_id !== packet.evaluation_id || existing.request_id !== packet.request_id) {
          throw new Error("Idempotency key already belongs to a different evaluation");
        }
        this.database.exec("COMMIT");
        return { created: false, evaluationId: existing.evaluation_id };
      }

      this.database.prepare(`
        INSERT INTO evaluation_runs (
          evaluation_id, tenant_id, request_id, idempotency_key, lead_id, account_id, score_version,
          outcome_status, packet_json, started_at, completed_at, retention_after
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        packet.evaluation_id, tenantId, packet.request_id, idempotencyKey, packet.lead_id, packet.account_id,
        packet.score_version, outcome, json(packet), packet.evaluation_timestamp, packet.evaluation_timestamp,
        input.retentionAfter ?? null
      );

      const insertStep = this.database.prepare(`
        INSERT INTO evaluation_steps (tenant_id, evaluation_id, step, status, detail, completed_at) VALUES (?, ?, ?, ?, ?, ?)
      `);
      for (const [step, result] of Object.entries(packet.tool_status)) {
        insertStep.run(tenantId, packet.evaluation_id, step, result.status, result.detail ?? null, result.completed_at);
      }

      const insertEvidence = this.database.prepare(`
        INSERT INTO evidence (tenant_id, evaluation_id, evidence_id, source_type, source_name, payload_json) VALUES (?, ?, ?, ?, ?, ?)
      `);
      for (const item of evidenceFrom(packet)) {
        insertEvidence.run(tenantId, packet.evaluation_id, item.evidence_id, item.source_type, item.source_name, json(item));
      }

      const insertClaim = this.database.prepare("INSERT INTO claims (tenant_id, evaluation_id, kind, text) VALUES (?, ?, ?, ?) RETURNING claim_id");
      const linkClaim = this.database.prepare("INSERT INTO claim_evidence (claim_id, evaluation_id, evidence_id) VALUES (?, ?, ?)");
      for (const claim of packet.allowed_claims) {
        const { claim_id } = insertClaim.get(tenantId, packet.evaluation_id, "allowed", claim.text) as { claim_id: number };
        for (const evidenceId of claim.evidence_ids) linkClaim.run(claim_id, packet.evaluation_id, evidenceId);
      }
      for (const claim of packet.disallowed_claims) insertClaim.get(tenantId, packet.evaluation_id, "disallowed", claim);

      this.database.prepare("INSERT INTO writeback_plans (tenant_id, evaluation_id, decision, reason) VALUES (?, ?, ?, ?)")
        .run(tenantId, packet.evaluation_id, packet.writeback_plan?.decision ?? null, packet.writeback_plan?.reason ?? null);
      this.database.prepare(`
        INSERT INTO writeback_outcomes (tenant_id, evaluation_id, status, reason, recorded_at) VALUES (?, ?, ?, ?, ?)
      `).run(tenantId, packet.evaluation_id, packet.writeback_outcome.status, packet.writeback_outcome.reason, packet.writeback_outcome.recorded_at);
      this.database.exec("COMMIT");
      return { created: true, evaluationId: packet.evaluation_id };
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  getEvaluation(tenantId: string, evaluationId: string) {
    const run = this.database.prepare(`
      SELECT outcome_status, packet_json FROM evaluation_runs WHERE tenant_id = ? AND evaluation_id = ?
    `).get(tenantId, evaluationId) as { outcome_status: EvaluationOutcome; packet_json: string } | undefined;
    if (!run) return null;
    const packet = parse<LeadPacket>(run.packet_json);
    assertLeadPacket(packet);
    const steps = this.database.prepare(`
      SELECT step, status, detail, completed_at FROM evaluation_steps WHERE tenant_id = ? AND evaluation_id = ? ORDER BY step
    `).all(tenantId, evaluationId);
    return { outcome: run.outcome_status, packet, steps } as const;
  }

  appendAuditRecord(input: AuditRecord) {
    const auditId = input.auditId ?? randomUUID();
    this.database.prepare(`
      INSERT INTO writeback_audit_records (
        audit_id, tenant_id, evaluation_id, request_id, crm_object_type, crm_object_id, field_name,
        previous_value_json, new_value_json, source_name, source_ref, source_updated_at, confidence,
        outcome, reason, score_version, actor_type, recorded_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      auditId, input.tenantId, input.evaluationId, input.requestId, input.crmObjectType, input.crmObjectId,
      input.fieldName, input.previousValue === undefined ? null : json(input.previousValue),
      input.newValue === undefined ? null : json(input.newValue), input.sourceName, input.sourceRef,
      input.sourceUpdatedAt, input.confidence, input.outcome, input.reason, input.scoreVersion, input.actorType,
      input.recordedAt ?? new Date().toISOString()
    );
    return auditId;
  }

  appendEvent(input: EventRecord) {
    const eventId = input.eventId ?? randomUUID();
    this.database.prepare(`
      INSERT INTO events (event_id, tenant_id, evaluation_id, request_id, event_type, payload_json, occurred_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      eventId, input.tenantId, input.evaluationId ?? null, input.requestId ?? null,
      nonEmpty(input.eventType, "eventType"), json(input.payload), input.occurredAt ?? new Date().toISOString()
    );
    return eventId;
  }

  listRetentionCandidates(before: string) {
    if (!Number.isFinite(Date.parse(before))) throw new Error("before must be an ISO date");
    return this.database.prepare(`
      SELECT tenant_id, evaluation_id, retention_after FROM evaluation_runs
      WHERE retention_after IS NOT NULL AND retention_after <= ? ORDER BY retention_after
    `).all(before);
  }
}
