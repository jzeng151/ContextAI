import assert from "node:assert/strict";
import test from "node:test";
import { leads } from "../src/data/leads.ts";
import { defaultConfigVersion } from "../src/lib/config.ts";
import { migrateDatabase, migrations } from "../src/lib/migrations.ts";
import { createEvaluationIdentifiers, RuntimeStore } from "../src/lib/persistence.ts";

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

test("a clean store upgrades from schema v1 and failed migrations roll back", () => {
  const store = new RuntimeStore(":memory:", 1);
  try {
    assert.equal((store.database.prepare("SELECT max(version) AS version FROM schema_migrations").get() as { version: number }).version, 1);
    assert.throws(() => store.database.prepare("SELECT * FROM events").all(), /no such table/i);

    migrateDatabase(store.database);
    assert.equal((store.database.prepare("SELECT max(version) AS version FROM schema_migrations").get() as { version: number }).version, 2);

    assert.throws(() => migrateDatabase(store.database, [
      ...migrations,
      { version: 3, name: "broken", sql: "CREATE TABLE should_rollback (id TEXT); INVALID SQL;" }
    ]), /Migration 3.*failed/);
    assert.equal((store.database.prepare("SELECT count(*) AS count FROM schema_migrations WHERE version = 3").get() as { count: number }).count, 0);
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
    assert.equal((store.database.prepare("SELECT count(*) AS count FROM config_versions").get() as { count: number }).count, 1);
  } finally {
    store.close();
  }
});

test("audit and event records are append-only and retention is only surfaced as a hook", () => {
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

    const auditId = store.appendAuditRecord({
      ...audit,
      auditId: "audit-1",
      tenantId: "tenant-1",
      previousValue: "Manager",
      newValue: "Director of IT"
    });
    const eventId = store.appendEvent({ eventId: "event-1", tenantId: "tenant-1", evaluationId: packet.evaluation_id, requestId: packet.request_id, eventType: "evaluation.completed", payload: { outcome: "complete" } });

    assert.equal(auditId, "audit-1");
    assert.equal(eventId, "event-1");
    assert.throws(() => store.database.prepare("UPDATE writeback_audit_records SET reason = 'changed' WHERE audit_id = 'audit-1'").run(), /append-only/i);
    assert.throws(() => store.database.prepare("DELETE FROM events WHERE event_id = 'event-1'").run(), /append-only/i);
    assert.throws(() => store.database.prepare("INSERT OR REPLACE INTO writeback_audit_records SELECT * FROM writeback_audit_records WHERE audit_id = 'audit-1'").run(), /append-only/i);
    assert.throws(() => store.database.prepare("INSERT OR REPLACE INTO events SELECT * FROM events WHERE event_id = 'event-1'").run(), /append-only/i);
    assert.equal(store.listRetentionCandidates("2027-07-01T04:00:00.000Z").length, 0);
    const retentionCandidates = store.listRetentionCandidates("2027-07-01T06:00:00.000Z") as Array<{ retention_after: string }>;
    assert.equal(retentionCandidates[0]?.retention_after, "2027-07-01T05:00:00.000Z");
    assert.equal(store.getEvaluation("tenant-1", packet.evaluation_id)?.packet.lead_id, packet.lead_id);
  } finally {
    store.close();
  }
});
