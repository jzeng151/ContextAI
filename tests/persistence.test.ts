import assert from "node:assert/strict";
import test from "node:test";
import { leads } from "../src/data/leads.ts";
import { defaultConfigVersion } from "../src/lib/config.ts";
import { assertPilotEvent, createEventRecorder, pilotEventNames, type PilotEvent } from "../src/lib/instrumentation.ts";
import { migrateDatabase, migrations } from "../src/lib/migrations.ts";
import { createEvaluationIdentifiers, RuntimeStore } from "../src/lib/persistence.ts";
import { compileAllowedClaims, fallbackGroundedExplanation } from "../src/lib/grounding.ts";

const lead = (id: string) => {
  const packet = leads.find(({ lead_id }) => lead_id === id);
  assert.ok(packet);
  return packet;
};

test("evaluation identifiers preserve an optional batch request ID", () => {
  const first = createEvaluationIdentifiers("request-batch");
  const second = createEvaluationIdentifiers("request-batch");
  assert.equal(first.requestId, second.requestId);
  assert.notEqual(first.evaluationId, second.evaluationId);
  assert.match(createEvaluationIdentifiers().requestId, /^[0-9a-f-]{36}$/);
});

test("persistence rejects control characters before writing JSON payloads", () => {
  const store = new RuntimeStore(":memory:");
  try {
    assert.throws(() => store.saveTenant("tenant-unsafe", "Pilot\tTenant"), /control characters/i);
    store.saveTenant("tenant-1", "Pilot tenant");
    store.saveConfigVersion("tenant-1", defaultConfigVersion);
    const packet = structuredClone(lead("golden-normal"));
    packet.crm_context.owner = "Rep\nInjected";
    assert.throws(
      () => store.saveEvaluation({ tenantId: "tenant-1", idempotencyKey: "unsafe", packet }),
      /control characters/i
    );
  } finally {
    store.close();
  }
});

test("a clean store upgrades from schema v1 and failed migrations roll back", () => {
  const store = new RuntimeStore(":memory:", 1);
  try {
    assert.equal((store.database.prepare("SELECT max(version) AS version FROM schema_migrations").get() as { version: number }).version, 1);
    assert.throws(() => store.database.prepare("SELECT * FROM events").all(), /no such table/i);

    migrateDatabase(store.database);
    assert.equal((store.database.prepare("SELECT max(version) AS version FROM schema_migrations").get() as { version: number }).version, 4);

    assert.throws(() => migrateDatabase(store.database, [
      ...migrations,
      { version: 5, name: "broken", sql: "CREATE TABLE should_rollback (id TEXT); INVALID SQL;" }
    ]), /Migration 5.*failed/);
    assert.equal((store.database.prepare("SELECT count(*) AS count FROM schema_migrations WHERE version = 5").get() as { count: number }).count, 0);
    assert.throws(() => store.database.prepare("SELECT * FROM should_rollback").all(), /no such table/i);
  } finally {
    store.close();
  }
});

test("complete and partial-failure evaluations persist with idempotency", () => {
  const store = new RuntimeStore(":memory:");
  try {
    store.saveTenant("tenant-1", "Pilot tenant");
    store.saveIntegration({ integrationId: "integration-1", tenantId: "tenant-1", provider: "hubspot", externalAccountId: "portal-1", status: "active" });
    store.saveConfigVersion("tenant-1", defaultConfigVersion);
    store.saveConfigVersion("tenant-1", { ...defaultConfigVersion, id: "score-draft", status: "draft" });
    assert.throws(
      () => store.saveConfigVersion("tenant-1", { ...defaultConfigVersion, id: "second-active" }),
      /unique constraint/i
    );
    const complete = lead("golden-normal");
    const partial = lead("no-usable-data");
    const skipped = structuredClone(lead("no-public-signal"));
    skipped.evaluation_id = "eval-skipped";
    skipped.tool_status.fetch_public_signals = { status: "skipped", detail: "Skipped for test.", completed_at: skipped.evaluation_timestamp };

    store.saveTenant("tenant-without-config", "No config tenant");
    assert.throws(
      () => store.saveEvaluation({ tenantId: "tenant-without-config", idempotencyKey: "missing-config", packet: complete }),
      /foreign key constraint/i
    );

    assert.deepEqual(store.saveEvaluation({ tenantId: "tenant-1", idempotencyKey: "golden", packet: complete }), {
      created: true,
      evaluationId: complete.evaluation_id
    });
    assert.equal(store.saveEvaluation({ tenantId: "tenant-1", idempotencyKey: "partial", packet: partial }).created, true);
    assert.equal(store.saveEvaluation({ tenantId: "tenant-1", idempotencyKey: "skipped", packet: skipped }).created, true);
    assert.equal(store.saveEvaluation({ tenantId: "tenant-1", idempotencyKey: "golden", packet: complete }).created, false);
    assert.throws(
      () => store.saveEvaluation({ tenantId: "tenant-1", idempotencyKey: "golden", packet: partial }),
      /different evaluation/i
    );

    const savedComplete = store.getEvaluation("tenant-1", complete.evaluation_id);
    const savedPartial = store.getEvaluation("tenant-1", partial.evaluation_id);
    assert.equal(savedComplete?.packet.lead_id, "golden-normal");
    assert.equal(savedComplete?.steps.length, 6);
    assert.equal(savedPartial?.outcome, "partial_failure");
    assert.equal(savedPartial?.packet.tool_status.fetch_intent_triggers.status, "timeout");
    assert.equal(store.getEvaluation("tenant-1", skipped.evaluation_id)?.outcome, "partial_failure");
    assert.ok((store.database.prepare("SELECT count(*) AS count FROM evidence WHERE evaluation_id = ?").get(complete.evaluation_id) as { count: number }).count > 0);
    assert.ok((store.database.prepare("SELECT count(*) AS count FROM claims WHERE evaluation_id = ?").get(complete.evaluation_id) as { count: number }).count > 0);
    assert.equal((store.database.prepare("SELECT count(*) AS count FROM config_versions").get() as { count: number }).count, 2);
  } finally {
    store.close();
  }
});

test("audit records are append-only and retention is only surfaced as a hook", () => {
  const store = new RuntimeStore(":memory:");
  try {
    store.saveTenant("tenant-1", "Pilot tenant");
    store.saveTenant("tenant-2", "Other tenant");
    store.saveConfigVersion("tenant-1", defaultConfigVersion);
    const packet = lead("golden-normal");
    store.saveEvaluation({
      tenantId: "tenant-1",
      idempotencyKey: "golden",
      packet,
      retentionAfter: "2027-07-01T00:00:00-05:00"
    });

    const audit = {
      auditId: "audit-cross-tenant",
      tenantId: "tenant-2",
      evaluationId: packet.evaluation_id,
      requestId: packet.request_id,
      crmObjectType: "contact",
      crmObjectId: packet.lead_id,
      fieldName: "contact_title",
      sourceName: "Fixture enrichment",
      sourceRef: "fixture:golden-normal",
      sourceUpdatedAt: packet.evaluation_timestamp,
      confidence: "High",
      outcome: "Written",
      reason: "Eligible fixture write",
      scoreVersion: packet.score_version,
      actorType: "system"
    } as const;
    assert.throws(() => store.appendAuditRecord(audit), /foreign key constraint/i);
    assert.throws(
      () => store.appendAuditRecord({ ...audit, auditId: "audit-wrong-request", tenantId: "tenant-1", requestId: "wrong-request" }),
      /foreign key constraint/i
    );
    assert.throws(
      () => store.appendAuditRecord({ ...audit, auditId: "audit-wrong-version", tenantId: "tenant-1", scoreVersion: "wrong-version" }),
      /foreign key constraint/i
    );

    const auditId = store.appendAuditRecord({
      ...audit,
      auditId: "audit-1",
      tenantId: "tenant-1",
      previousValue: "Manager",
      newValue: "Director of IT"
    });
    const claims = compileAllowedClaims(packet);
    const explanation = fallbackGroundedExplanation(packet);
    const hookClaim = claims.find((claim) => claim.hook);
    assert.ok(hookClaim);
    explanation.hook_recommendation = hookClaim.hook;
    explanation.hook_claim_ids = [hookClaim.claim_id];
    const groundingAudit = {
      prompt_version: "grounding-v1",
      model_id: "test-model",
      evaluation_id: packet.evaluation_id,
      allowed_claim_ids: claims.map((claim) => claim.claim_id),
      evidence_ids: [...new Set(claims.flatMap((claim) => claim.evidence_ids))],
    };
    const groundingAuditId = store.appendGroundingAudit("tenant-1", explanation, claims, { ...groundingAudit, outcome: "validated" });
    store.appendGroundingAudit("tenant-1", fallbackGroundedExplanation(packet), claims, { ...groundingAudit, outcome: "fallback", failure: "invalid_output" });
    assert.doesNotThrow(() => store.appendGroundingAudit("tenant-1", fallbackGroundedExplanation(packet), claims, { ...groundingAudit, outcome: "fallback" }));
    assert.throws(
      () => store.appendGroundingAudit("tenant-1", explanation, claims, { ...groundingAudit, outcome: "validated", failure: "invalid_output" }),
      /CHECK constraint failed/i,
    );
    assert.equal(auditId, "audit-1");
    assert.equal(groundingAuditId, 1);
    assert.throws(() => store.database.prepare("UPDATE writeback_audit_records SET reason = 'changed' WHERE audit_id = 'audit-1'").run(), /append-only/i);
    assert.throws(() => store.database.prepare("DELETE FROM grounding_audit_records WHERE grounding_audit_id = 1").run(), /append-only/i);
    assert.throws(() => store.database.prepare("INSERT OR REPLACE INTO grounding_audit_records SELECT * FROM grounding_audit_records WHERE grounding_audit_id = 1").run(), /append-only/i);
    assert.throws(() => store.database.prepare("INSERT OR REPLACE INTO writeback_audit_records SELECT * FROM writeback_audit_records WHERE audit_id = 'audit-1'").run(), /append-only/i);
    assert.equal(store.listRetentionCandidates("2027-07-01T04:00:00.000Z").length, 0);
    const retentionCandidates = store.listRetentionCandidates("2027-07-01T06:00:00.000Z") as Array<{ retention_after: string }>;
    assert.equal(retentionCandidates[0]?.retention_after, "2027-07-01T05:00:00.000Z");
    assert.equal(store.getEvaluation("tenant-1", packet.evaluation_id)?.packet.lead_id, packet.lead_id);
    const grounding = store.database.prepare("SELECT * FROM grounding_audit_records WHERE grounding_audit_id = 1").get() as Record<string, string>;
    assert.deepEqual(JSON.parse(grounding.allowed_claim_ids_json), claims.map((claim) => claim.claim_id));
    assert.deepEqual(JSON.parse(grounding.compiled_claims_json).map((claim: { driver: string }) => claim.driver), claims.map((claim) => claim.driver));
    assert.deepEqual(JSON.parse(grounding.hook_claim_ids_json), [hookClaim.claim_id]);
    assert.deepEqual(JSON.parse(grounding.output_json), explanation);
    assert.equal((store.database.prepare("SELECT failure FROM grounding_audit_records WHERE grounding_audit_id = 2").get() as { failure: string }).failure, "invalid_output");
  } finally {
    store.close();
  }
});

test("pilot event contract records every event idempotently without PII or reporting imports", () => {
  const store = new RuntimeStore(":memory:");
  try {
    store.saveTenant("tenant-1", "Pilot tenant");
    store.saveConfigVersion("tenant-1", defaultConfigVersion);
    const packet = lead("golden-normal");
    store.saveEvaluation({ tenantId: "tenant-1", idempotencyKey: "golden", packet });
    const base = {
      tenantId: "tenant-1",
      requestId: packet.request_id,
      evaluationId: packet.evaluation_id,
      leadId: packet.lead_id,
      accountId: packet.account_id,
      actorType: "rep" as const,
      actorId: "rep-1",
      scoreVersion: packet.score_version,
      configVersion: packet.score_version,
      promptVersion: "grounding-v1",
      evidenceRefs: [] as string[],
      retentionClass: "pilot_analytics_12_months" as const,
      occurredAt: packet.evaluation_timestamp
    };
    const events: PilotEvent[] = [
      { ...base, eventId: "event-evaluation", idempotencyKey: "fixture:evaluation", name: "evaluation.run", data: { outcome: "complete", priorityScore: packet.priority_score, priorityBand: packet.priority_band } },
      { ...base, idempotencyKey: "fixture:score", name: "score.shown", data: { priorityScore: packet.priority_score, priorityBand: packet.priority_band, surface: "dashboard" } },
      { ...base, idempotencyKey: "fixture:view", name: "lead.viewed", data: { surface: "dashboard" } },
      { ...base, idempotencyKey: "fixture:action", name: "action.first_meaningful", data: { actionType: "call" } },
      { ...base, idempotencyKey: "fixture:disposition", name: "recommendation.disposition", data: { disposition: "accepted", actionType: "call" } },
      { ...base, evidenceRefs: [packet.crm_context.evidence[0]!.evidence_id], idempotencyKey: "fixture:source", name: "source.contribution", data: { sourceType: "crm", contribution: "primary", weakSignal: false } },
      { ...base, retentionClass: "writeback_audit_24_months", idempotencyKey: "fixture:write", name: "writeback.outcome", data: { writebackId: "write-1", outcome: "Written", fieldName: "contact_title" } },
      { ...base, retentionClass: "writeback_audit_24_months", idempotencyKey: "fixture:edit", name: "writeback.edit", data: { writebackId: "write-1", fieldName: "contact_title" } },
      { ...base, retentionClass: "writeback_audit_24_months", idempotencyKey: "fixture:rollback", name: "writeback.rollback", data: { writebackId: "write-1", rollbackId: "rollback-1", fieldName: "contact_title" } },
      { ...base, idempotencyKey: "fixture:meeting", name: "meeting.attribution", data: { meetingId: "meeting-1", attribution: "crm_association" } },
      { ...base, idempotencyKey: "fixture:outcome", name: "outcome.attribution", data: { outcomeId: "outcome-1", outcomeType: "opportunity_created", attribution: "crm_association" } }
    ];

    for (const event of events) assert.equal(store.recordEvent(event).created, true);
    assert.deepEqual(events.map(({ name }) => name), pilotEventNames);
    const evaluationEvent = events[0] as Extract<PilotEvent, { name: "evaluation.run" }>;
    const editEvent = events[7] as Extract<PilotEvent, { name: "writeback.edit" }>;
    assert.equal(store.recordEvent(evaluationEvent).created, false);
    assert.throws(() => store.recordEvent({ ...evaluationEvent, data: { ...evaluationEvent.data, outcome: "partial_failure" } }), /different event/i);
    assert.throws(() => store.recordEvent({ ...events[1]!, idempotencyKey: "bad-version", scoreVersion: "wrong-version" }), /does not match/i);
    assert.throws(() => store.recordEvent({ ...events[5]!, idempotencyKey: "bad-evidence", evidenceRefs: ["missing"] }), /outside its evaluation/i);
    assert.throws(() => store.recordEvent({ ...editEvent, idempotencyKey: "missing-write", data: { writebackId: "missing", fieldName: "contact_title" } }), /linked Written/i);
    assert.throws(() => store.database.prepare("UPDATE events SET event_type = 'changed' WHERE event_id = 'event-evaluation'").run(), /append-only/i);
    assert.throws(() => store.database.prepare("DELETE FROM events WHERE event_id = 'event-evaluation'").run(), /append-only/i);

    const missingRequired = structuredClone(events[3]!) as unknown as { data: Record<string, unknown> };
    delete missingRequired.data.actionType;
    assert.throws(() => assertPilotEvent(missingRequired), /actionType is required/i);
    assert.throws(
      () => assertPilotEvent({ ...editEvent, data: { ...editEvent.data, fieldName: undefined } }),
      /fieldName is required/i
    );
    assert.throws(
      () => assertPilotEvent({ ...events[2]!, retentionClass: "writeback_audit_24_months" }),
      /lead\.viewed requires pilot_analytics_12_months/i
    );
    assert.throws(() => assertPilotEvent({ ...events[2]!, idempotencyKey: "pii", email: "rep@example.com" }), /excluded PII/i);

    const failures: string[] = [];
    const recordEvent = createEventRecorder(store, ({ reason }) => failures.push(reason));
    recordEvent({ ...events[2]!, idempotencyKey: "pii-safe-failure", actorId: "rep@example.com" });
    assert.equal(failures.length, 1);
    assert.equal(store.getEvaluation("tenant-1", packet.evaluation_id)?.packet.priority_score, packet.priority_score);
  } finally {
    store.close();
  }
});
