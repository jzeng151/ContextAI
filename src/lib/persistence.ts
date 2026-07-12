import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import { assertConfigVersion, type ScoringConfigVersion } from "./config.ts";
import { assertLeadPacket, type Evidence, type LeadPacket } from "./contextai.ts";
import { assertPilotEvent, type PilotEvent } from "./instrumentation.ts";
import { migrateDatabase } from "./migrations.ts";
import { hubSpotRequiredScopes } from "./integrations.ts";
import { assertAdminAccess, assertRequestIdentity, assertTenantAccess, canReadAssignedEvaluation, type RequestIdentity } from "./security.ts";
import { decryptSecret, encryptSecret } from "./secrets.ts";
import type { GroundedClaim, GroundedExplanation, GroundingAudit } from "./grounding.ts";

export type EvaluationOutcome = "complete" | "partial_failure";

type EvaluationInput = Readonly<{
  tenantId: string;
  idempotencyKey: string;
  packet: LeadPacket;
  assignedRepId?: string;
  retentionAfter?: string;
}>;

type AuditRecord = Readonly<{
  auditId?: string;
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
  recordedAt?: string;
}>;

const controlText = /[\u0000-\u001f\u007f]/;
const nonEmpty = (value: string, name: string) => {
  if (!value.trim()) throw new Error(`${name} is required`);
  if (controlText.test(value)) throw new Error(`${name} must not contain control characters`);
  return value;
};
const json = (value: unknown) => {
  const serialized = JSON.stringify(value, (_key, item) => {
    if (typeof item === "string" && controlText.test(item)) throw new Error("persisted text must not contain control characters");
    return item;
  });
  if (serialized === undefined) throw new Error("value must be JSON serializable");
  return serialized;
};
const parse = <T>(value: string) => JSON.parse(value) as T;
const failedStatuses = new Set(["unavailable", "timeout", "rate_limited", "invalid_result", "skipped"]);
const isoDate = (value: string, name: string) => {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) throw new Error(`${name} must be an ISO date`);
  return new Date(timestamp).toISOString();
};

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
  readonly evaluationRetentionDays: number;

  constructor(path = process.env.DATABASE_PATH ?? ".contextai/contextai.sqlite", targetVersion?: number, evaluationRetentionDays = Number(process.env.EVALUATION_RETENTION_DAYS ?? 365)) {
    if (!Number.isSafeInteger(evaluationRetentionDays) || evaluationRetentionDays < 1) throw new Error("evaluation retention days must be a positive integer");
    this.evaluationRetentionDays = evaluationRetentionDays;
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.database = new DatabaseSync(path);
    this.database.exec("PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL;");
    migrateDatabase(this.database, undefined, targetVersion);
  }

  close() {
    this.database.close();
  }

  private recordAccess(identity: RequestIdentity, action: string, resourceType: string, resourceId: string, outcome: "allowed" | "denied") {
    this.database.prepare(`
      INSERT INTO access_audit_records (
        tenant_id, request_id, actor_id, actor_role, action, resource_type, resource_id, outcome, recorded_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      identity.tenantId, identity.requestId, identity.actorId, identity.role, action, resourceType, resourceId,
      outcome, new Date().toISOString()
    );
  }

  private requireAdmin(identity: RequestIdentity, action: string, resourceType: string, resourceId: string) {
    assertRequestIdentity(identity);
    try {
      assertAdminAccess(identity);
    } catch (error) {
      this.recordAccess(identity, action, resourceType, resourceId, "denied");
      throw error;
    }
  }

  saveTenant(tenantId: string, name: string) {
    this.database.prepare("INSERT OR IGNORE INTO tenants (tenant_id, name, created_at) VALUES (?, ?, ?)")
      .run(nonEmpty(tenantId, "tenantId"), nonEmpty(name, "tenant name"), new Date().toISOString());
  }

  saveIntegration(identity: RequestIdentity, input: Readonly<{ integrationId: string; provider: string; externalAccountId: string; status: "active" | "disabled" | "error" }>) {
    this.requireAdmin(identity, "integration.create", "integration", input.integrationId);
    if (input.status === "active") throw new Error("Active integrations require encrypted OAuth credentials");
    json(input);
    this.database.prepare(`
      INSERT INTO integrations (integration_id, tenant_id, provider, external_account_id, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(input.integrationId, identity.tenantId, input.provider, input.externalAccountId, input.status, new Date().toISOString());
    this.recordAccess(identity, "integration.create", "integration", input.integrationId, "allowed");
  }

  activateHubSpotIntegration(identity: RequestIdentity, integrationId: string, credentials: Readonly<{
    accessToken: string;
    refreshToken: string;
    scopes: readonly string[];
    expiresAt: string;
    externalAccountId: string;
  }>, key: Buffer) {
    this.requireAdmin(identity, "integration.connect", "integration", integrationId);
    if (hubSpotRequiredScopes.some((scope) => !credentials.scopes.includes(scope))) throw new Error("HubSpot OAuth scopes are insufficient");
    const result = this.database.prepare(`
      UPDATE integrations SET
        status = 'active', access_token_ciphertext = ?, refresh_token_ciphertext = ?, scopes_json = ?,
        token_expires_at = ?, last_error = NULL, rate_limited_until = NULL, revoked_at = NULL
      WHERE tenant_id = ? AND integration_id = ? AND provider = 'hubspot' AND external_account_id = ?
    `).run(
      encryptSecret(credentials.accessToken, key), encryptSecret(credentials.refreshToken, key), json(credentials.scopes),
      isoDate(credentials.expiresAt, "expiresAt"), identity.tenantId, integrationId, credentials.externalAccountId
    );
    if (result.changes !== 1) throw new Error("HubSpot integration not found");
    this.recordAccess(identity, "integration.connect", "integration", integrationId, "allowed");
  }

  getHubSpotAccessToken(identity: RequestIdentity, integrationId: string, key: Buffer, now = new Date().toISOString()) {
    assertTenantAccess(identity, identity.tenantId);
    if (identity.role !== "system" && identity.role !== "integration") throw new Error("Integration worker access required");
    const integration = this.database.prepare(`
      SELECT status, access_token_ciphertext, token_expires_at, rate_limited_until, revoked_at
      FROM integrations WHERE tenant_id = ? AND integration_id = ? AND provider = 'hubspot'
    `).get(identity.tenantId, integrationId) as {
      status: string;
      access_token_ciphertext: string | null;
      token_expires_at: string | null;
      rate_limited_until: string | null;
      revoked_at: string | null;
    } | undefined;
    const nowMs = Date.parse(isoDate(now, "now"));
    if (!integration || integration.status !== "active" || integration.revoked_at || !integration.access_token_ciphertext) {
      throw new Error("HubSpot integration is disconnected");
    }
    if (integration.rate_limited_until && Date.parse(integration.rate_limited_until) > nowMs) throw new Error("HubSpot integration is rate limited");
    if (!integration.token_expires_at || Date.parse(integration.token_expires_at) <= nowMs) throw new Error("HubSpot access token is expired");
    return decryptSecret(integration.access_token_ciphertext, key);
  }

  async disconnectHubSpotIntegration(
    identity: RequestIdentity,
    integrationId: string,
    key: Buffer,
    revoke: (refreshToken: string) => Promise<void>,
  ) {
    this.requireAdmin(identity, "integration.disconnect", "integration", integrationId);
    const row = this.database.prepare(`
      SELECT refresh_token_ciphertext FROM integrations
      WHERE tenant_id = ? AND integration_id = ? AND provider = 'hubspot'
    `).get(identity.tenantId, integrationId) as { refresh_token_ciphertext: string | null } | undefined;
    if (!row) throw new Error("HubSpot integration not found");
    const refreshToken = row.refresh_token_ciphertext ? decryptSecret(row.refresh_token_ciphertext, key) : null;
    this.database.prepare(`
      UPDATE integrations SET status = 'disabled', access_token_ciphertext = NULL, revoked_at = ?, rate_limited_until = NULL
      WHERE tenant_id = ? AND integration_id = ?
    `).run(new Date().toISOString(), identity.tenantId, integrationId);
    try {
      if (refreshToken) await revoke(refreshToken);
      this.database.prepare(`
        UPDATE integrations SET refresh_token_ciphertext = NULL, last_error = NULL
        WHERE tenant_id = ? AND integration_id = ?
      `).run(identity.tenantId, integrationId);
      this.recordAccess(identity, "integration.disconnect", "integration", integrationId, "allowed");
    } catch (error) {
      this.database.prepare(`
        UPDATE integrations SET status = 'error', last_error = 'token_revocation_failed'
        WHERE tenant_id = ? AND integration_id = ?
      `).run(identity.tenantId, integrationId);
      throw error;
    }
  }

  recordIntegrationHealth(identity: RequestIdentity, integrationId: string, status: "healthy" | "error" | "rate_limited", retryAfter?: string) {
    assertRequestIdentity(identity);
    if (identity.role === "rep") throw new Error("Rep access denied");
    const result = this.database.prepare(`
      UPDATE integrations SET status = ?, last_health_at = ?, last_error = ?, rate_limited_until = ?
      WHERE tenant_id = ? AND integration_id = ?
    `).run(
      status === "error" ? "error" : "active", new Date().toISOString(), status === "error" ? "provider_error" : null,
      status === "rate_limited" && retryAfter ? isoDate(retryAfter, "retryAfter") : null, identity.tenantId, integrationId
    );
    if (result.changes !== 1) throw new Error("Integration not found");
  }

  getIntegrationStatus(identity: RequestIdentity, integrationId: string) {
    this.requireAdmin(identity, "integration.status", "integration", integrationId);
    const status = this.database.prepare(`
      SELECT provider, external_account_id, status, scopes_json, token_expires_at, last_health_at, last_error,
        rate_limited_until, revoked_at
      FROM integrations WHERE tenant_id = ? AND integration_id = ?
    `).get(identity.tenantId, integrationId);
    this.recordAccess(identity, "integration.status", "integration", integrationId, status ? "allowed" : "denied");
    return status ?? null;
  }

  saveConfigVersion(identity: RequestIdentity, version: ScoringConfigVersion) {
    this.requireAdmin(identity, "config.write", "config_version", version.id);
    assertConfigVersion(version);
    this.database.prepare(`
      INSERT INTO config_versions (tenant_id, version_id, status, created_by, created_at, config_json)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(identity.tenantId, version.id, version.status, version.author, version.createdAt, json(version));
    this.recordAccess(identity, "config.write", "config_version", version.id, "allowed");
  }

  saveEvaluation(input: EvaluationInput): Readonly<{ created: boolean; evaluationId: string }> {
    const { tenantId, idempotencyKey, packet } = input;
    assertLeadPacket(packet);
    nonEmpty(tenantId, "tenantId");
    nonEmpty(idempotencyKey, "idempotencyKey");
    const retentionAfter = input.retentionAfter === undefined
      ? new Date(Date.parse(packet.evaluation_timestamp) + this.evaluationRetentionDays * 24 * 60 * 60 * 1000).toISOString()
      : isoDate(input.retentionAfter, "retentionAfter");
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
          outcome_status, packet_json, started_at, completed_at, retention_after, assigned_rep_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        packet.evaluation_id, tenantId, packet.request_id, idempotencyKey, packet.lead_id, packet.account_id,
        packet.score_version, outcome, json(packet), packet.evaluation_timestamp, packet.evaluation_timestamp,
        retentionAfter, input.assignedRepId ?? null
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
      const linkClaim = this.database.prepare("INSERT INTO claim_evidence (tenant_id, claim_id, evaluation_id, evidence_id) VALUES (?, ?, ?, ?)");
      for (const claim of packet.allowed_claims) {
        const { claim_id } = insertClaim.get(tenantId, packet.evaluation_id, "allowed", claim.text) as { claim_id: number };
        for (const evidenceId of claim.evidence_ids) linkClaim.run(tenantId, claim_id, packet.evaluation_id, evidenceId);
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

  getEvaluation(identity: RequestIdentity, evaluationId: string) {
    assertRequestIdentity(identity);
    const run = this.database.prepare(`
      SELECT outcome_status, packet_json, assigned_rep_id, purged_at FROM evaluation_runs WHERE tenant_id = ? AND evaluation_id = ?
    `).get(identity.tenantId, evaluationId) as { outcome_status: EvaluationOutcome; packet_json: string; assigned_rep_id: string | null; purged_at: string | null } | undefined;
    if (!run || run.purged_at || !canReadAssignedEvaluation(identity, run.assigned_rep_id)) {
      this.recordAccess(identity, "evaluation.read", "evaluation", evaluationId, "denied");
      return null;
    }
    const packet = parse<LeadPacket>(run.packet_json);
    assertLeadPacket(packet);
    const steps = this.database.prepare(`
      SELECT step, status, detail, completed_at FROM evaluation_steps WHERE tenant_id = ? AND evaluation_id = ? ORDER BY step
    `).all(identity.tenantId, evaluationId);
    this.recordAccess(identity, "evaluation.read", "evaluation", evaluationId, "allowed");
    return { outcome: run.outcome_status, packet, steps } as const;
  }

  appendAuditRecord(identity: RequestIdentity, input: AuditRecord) {
    this.requireAdmin(identity, "writeback.execute", "evaluation", input.evaluationId);
    json(input);
    const auditId = input.auditId ?? randomUUID();
    this.database.prepare(`
      INSERT INTO writeback_audit_records (
        audit_id, tenant_id, evaluation_id, request_id, crm_object_type, crm_object_id, field_name,
        previous_value_json, new_value_json, source_name, source_ref, source_updated_at, confidence,
        outcome, reason, score_version, actor_type, recorded_at, actor_id, access_request_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      auditId, identity.tenantId, input.evaluationId, input.requestId, input.crmObjectType, input.crmObjectId,
      input.fieldName, input.previousValue === undefined ? null : json(input.previousValue),
      input.newValue === undefined ? null : json(input.newValue), input.sourceName, input.sourceRef,
      input.sourceUpdatedAt, input.confidence, input.outcome, input.reason, input.scoreVersion, identity.role,
      input.recordedAt ?? new Date().toISOString(), identity.actorId, identity.requestId
    );
    this.recordAccess(identity, "writeback.execute", "evaluation", input.evaluationId, "allowed");
    return auditId;
  }

  appendGroundingAudit(tenantId: string, explanation: GroundedExplanation, claims: GroundedClaim[], audit: GroundingAudit) {
    json({ tenantId, explanation, claims, audit });
    const result = this.database.prepare(`
      INSERT INTO grounding_audit_records (
        tenant_id, evaluation_id, prompt_version, model_id, allowed_claim_ids_json,
        evidence_ids_json, compiled_claims_json, hook_claim_ids_json, output_json, outcome, failure, recorded_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING grounding_audit_id
    `).get(
      nonEmpty(tenantId, "tenantId"), audit.evaluation_id, audit.prompt_version, audit.model_id,
      json(audit.allowed_claim_ids), json(audit.evidence_ids), json(claims), json(explanation.hook_claim_ids), json(explanation), audit.outcome,
      audit.failure ?? null, new Date().toISOString()
    ) as { grounding_audit_id: number };
    return result.grounding_audit_id;
  }

  recordEvent(input: PilotEvent) {
    assertPilotEvent(input);
    const existing = this.database.prepare(`
      SELECT event_id, payload_json FROM events WHERE tenant_id = ? AND idempotency_key = ?
    `).get(input.tenantId, input.idempotencyKey) as { event_id: string; payload_json: string } | undefined;
    if (existing) {
      const { eventId: _storedEventId, ...stored } = parse<PilotEvent>(existing.payload_json);
      const { eventId: _inputEventId, ...candidate } = input;
      if (!isDeepStrictEqual(stored, candidate)) throw new Error("Idempotency key already belongs to a different event");
      return { created: false, eventId: existing.event_id } as const;
    }

    const linkedEvaluation = this.database.prepare(`
      SELECT 1 FROM evaluation_runs
      WHERE tenant_id = ? AND evaluation_id = ? AND request_id = ? AND score_version = ?
    `).get(input.tenantId, input.evaluationId, input.requestId, input.scoreVersion);
    if (!linkedEvaluation) throw new Error("Event does not match its tenant, request, evaluation, and score version");
    const linkedConfig = this.database.prepare(`
      SELECT 1 FROM config_versions WHERE tenant_id = ? AND version_id = ?
    `).get(input.tenantId, input.configVersion);
    if (!linkedConfig) throw new Error("Event config version does not belong to its tenant");

    const evidenceExists = this.database.prepare(`
      SELECT 1 FROM evidence WHERE tenant_id = ? AND evaluation_id = ? AND evidence_id = ?
    `);
    if (input.evidenceRefs.some((ref) => !evidenceExists.get(input.tenantId, input.evaluationId, ref))) {
      throw new Error("Event references evidence outside its evaluation");
    }

    if (input.name === "writeback.edit" || input.name === "writeback.rollback") {
      const outcomes = this.database.prepare(`
        SELECT payload_json FROM events
        WHERE tenant_id = ? AND evaluation_id = ? AND event_type = 'writeback.outcome'
      `).all(input.tenantId, input.evaluationId) as Array<{ payload_json: string }>;
      const linkedWrite = outcomes.some(({ payload_json }) => {
        const event = parse<PilotEvent>(payload_json);
        return event.name === "writeback.outcome" && event.data.writebackId === input.data.writebackId && event.data.outcome === "Written";
      });
      if (!linkedWrite) throw new Error(`${input.name} requires a linked Written writeback.outcome`);
    }

    const eventId = input.eventId ?? randomUUID();
    const stored = { ...input, eventId };
    this.database.prepare(`
      INSERT INTO events (
        event_id, tenant_id, evaluation_id, request_id, event_type, payload_json, occurred_at, idempotency_key, retention_class
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      eventId, input.tenantId, input.evaluationId, input.requestId, input.name, json(stored), input.occurredAt,
      input.idempotencyKey, input.retentionClass
    );
    return { created: true, eventId } as const;
  }

  listRetentionCandidates(before: string) {
    return this.database.prepare(`
      SELECT tenant_id, evaluation_id, retention_after FROM evaluation_runs
      WHERE retention_after IS NOT NULL AND retention_after <= ? ORDER BY retention_after
    `).all(isoDate(before, "before"));
  }

  purgeExpiredEvaluations(identity: RequestIdentity, before: string) {
    this.requireAdmin(identity, "retention.purge", "tenant", identity.tenantId);
    const cutoff = isoDate(before, "before");
    const candidates = this.database.prepare(`
      SELECT evaluation_id FROM evaluation_runs
      WHERE tenant_id = ? AND purged_at IS NULL AND retention_after <= ?
    `).all(identity.tenantId, cutoff) as Array<{ evaluation_id: string }>;
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database.prepare("INSERT INTO retention_job_guard (active) VALUES (1)").run();
      for (const { evaluation_id: evaluationId } of candidates) {
        for (const table of ["claim_evidence", "claims", "evidence", "evaluation_steps", "writeback_plans", "writeback_outcomes", "review_items"] as const) {
          this.database.prepare(`DELETE FROM ${table} WHERE tenant_id = ? AND evaluation_id = ?`).run(identity.tenantId, evaluationId);
        }
        this.database.prepare(`
          DELETE FROM events
          WHERE tenant_id = ? AND evaluation_id = ? AND retention_class != 'writeback_audit_24_months'
        `).run(identity.tenantId, evaluationId);
        this.database.prepare(`
          UPDATE evaluation_runs SET packet_json = 'null', lead_id = '[deleted]', account_id = NULL, assigned_rep_id = NULL, purged_at = ?
          WHERE tenant_id = ? AND evaluation_id = ?
        `).run(new Date().toISOString(), identity.tenantId, evaluationId);
      }
      this.database.prepare("DELETE FROM retention_job_guard").run();
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    this.recordAccess(identity, "retention.purge", "tenant", identity.tenantId, "allowed");
    return candidates.length;
  }
}
