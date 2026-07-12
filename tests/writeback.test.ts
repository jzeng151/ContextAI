import assert from "node:assert/strict";
import test from "node:test";
import { defaultConfigVersion } from "../src/lib/config.ts";
import { leads } from "../src/data/leads.ts";
import { RuntimeStore } from "../src/lib/persistence.ts";
import { executeWriteback, hubSpotWritebackPolicy, planWriteback, rollbackLeadWriteback, rollbackWriteback } from "../src/lib/writeback.ts";

const packet = () => structuredClone(leads.find(({ lead_id }) => lead_id === "golden-normal")!);
const packetById = (leadId: string) => structuredClone(leads.find(({ lead_id }) => lead_id === leadId)!);

const storeFor = (lead = packet()) => {
  const store = new RuntimeStore(":memory:");
  store.saveTenant("tenant-1", "Pilot tenant");
  store.saveConfigVersion("tenant-1", defaultConfigVersion);
  store.saveEvaluation({ tenantId: "tenant-1", idempotencyKey: lead.evaluation_id, packet: lead });
  return store;
};

test("planning maps canonical evidence to CRM fields independently per field", () => {
  const lead = packet();
  const unrelated = { ...lead.enrichment_fields.evidence[0]!, evidence_id: "low-tech", confidence: "Low" as const, eligible_for_crm_writeback: false, field_name: undefined, field_values: { tech_stack: ["UnverifiedTech"] } };
  lead.enrichment_fields.evidence.push(unrelated);
  const plan = planWriteback(lead, hubSpotWritebackPolicy);

  assert.equal(plan.fields.find(({ canonicalField }) => canonicalField === "employees")?.crmField, "numberofemployees");
  assert.equal(plan.fields.find(({ canonicalField }) => canonicalField === "tech_stack")?.crmField, "technology_tags");
  assert.equal(plan.fields.find(({ canonicalField }) => canonicalField === "employees")?.outcome, "Eligible");
  const blocked = planWriteback(lead, { ...hubSpotWritebackPolicy, fields: { ...hubSpotWritebackPolicy.fields, employees: { object: "company", crmField: "owner", type: "number" } } });
  assert.equal(blocked.fields.find(({ canonicalField }) => canonicalField === "employees")?.outcome, "Blocked");
  const sideEffect = planWriteback(lead, { ...hubSpotWritebackPolicy, fields: { ...hubSpotWritebackPolicy.fields, employees: { ...hubSpotWritebackPolicy.fields.employees!, sideEffects: true } } });
  assert.equal(sideEffect.fields.find(({ canonicalField }) => canonicalField === "employees")?.outcome, "Blocked");
});

test("planning handles empty, invalid, stale, low-confidence, and conflicting fields", () => {
  for (const [name, mutate, expected] of [
    ["empty", (lead: ReturnType<typeof packet>) => { lead.enrichment_fields.tech_stack = []; lead.enrichment_fields.evidence[0]!.field_values!.tech_stack = []; }, "Skipped"],
    ["invalid", (_lead: ReturnType<typeof packet>) => {}, "Blocked"],
    ["stale", (lead: ReturnType<typeof packet>) => { lead.enrichment_fields.evidence[0]!.source_updated_at = "2025-01-01T00:00:00.000Z"; lead.enrichment_fields.last_updated_days_ago = Math.floor((Date.parse(lead.evaluation_timestamp) - Date.parse("2025-01-01T00:00:00.000Z")) / 86_400_000); }, "Flagged for Review"],
    ["low", (lead: ReturnType<typeof packet>) => { lead.enrichment_fields.evidence[0]!.confidence = "Low"; }, "Flagged for Review"],
    ["conflict", (lead: ReturnType<typeof packet>) => { lead.enrichment_fields.evidence.push({ ...lead.enrichment_fields.evidence[0]!, evidence_id: "crm-employees", source_type: "crm", source_name: "HubSpot", eligible_for_crm_writeback: false, field_name: undefined, field_values: { employees: 25 }, field_value: 25 }); }, "Flagged for Review"]
  ] as const) {
    const lead = packet();
    mutate(lead);
    const field = name === "empty" ? "tech_stack" : "employees";
    const policy = name === "invalid"
      ? { ...hubSpotWritebackPolicy, fields: { ...hubSpotWritebackPolicy.fields, employees: { ...hubSpotWritebackPolicy.fields.employees!, type: "string" as const } } }
      : hubSpotWritebackPolicy;
    assert.equal(planWriteback(lead, policy).fields.find(({ canonicalField }) => canonicalField === field)?.outcome, expected, name);
  }
  const empty = planWriteback(packetById("no-usable-data"), hubSpotWritebackPolicy);
  assert.deepEqual([empty.fields.length, empty.outcome], [0, "Skipped"]);
  const staleCrm = packet();
  staleCrm.enrichment_fields.evidence.push({
    ...staleCrm.enrichment_fields.evidence[0]!, evidence_id: "stale-crm-employees", source_type: "crm", source_name: "HubSpot",
    source_updated_at: "2025-01-01T00:00:00.000Z", eligible_for_crm_writeback: false, field_name: undefined,
    field_value: 25, field_values: { employees: 25 }
  });
  assert.equal(planWriteback(staleCrm, hubSpotWritebackPolicy).fields.find(({ canonicalField }) => canonicalField === "employees")?.outcome, "Eligible");
  assert.throws(
    () => planWriteback(packet(), { ...hubSpotWritebackPolicy, blockedFields: hubSpotWritebackPolicy.blockedFields.filter((field) => field !== "owner") }),
    /invalid writeback policy/i
  );
});

test("execution is dry-run-first and retries do not repeat writes", async () => {
  const lead = packet();
  const store = storeFor(lead);
  let writes = 0;
  const writtenFields: string[] = [];
  try {
    const plan = planWriteback(lead, hubSpotWritebackPolicy);
    const dryRun = await executeWriteback(plan, { store, tenantId: "tenant-1", actorType: "system", actorId: "writeback-service", write: async () => { writes += 1; } });
    assert.ok(dryRun.every(({ outcome }) => outcome === "Skipped"));
    assert.equal(writes, 0);
    await assert.rejects(executeWriteback(plan, { store, tenantId: "tenant-1", actorType: "system", actorId: "writeback-service", mode: "live", authorizedLiveWrite: true, write: async () => { writes += 1; } }), /not explicitly enabled/i);

    const livePlan = planWriteback(lead, { ...hubSpotWritebackPolicy, liveWritesEnabled: true });
    const options = { store, tenantId: "tenant-1", actorType: "system", actorId: "writeback-service", mode: "live" as const, authorizedLiveWrite: true, write: async ({ properties }: { properties: Readonly<Record<string, unknown>> }) => { writes += 1; writtenFields.push(...Object.keys(properties)); } };
    const forged = { ...livePlan, fields: livePlan.fields.map((field, index) => index === 0 ? { ...field, crmField: "owner" } : field) };
    const first = await executeWriteback(forged, options);
    const second = await executeWriteback(livePlan, options);
    assert.ok(first.every(({ outcome }) => outcome === "Written"));
    assert.deepEqual(second, first);
    assert.equal(writes, first.length);
    assert.equal(writtenFields.includes("owner"), false);
  } finally {
    store.close();
  }
});

test("field rollback writes the previous value and preserves an immutable audit chain", async () => {
  const lead = packet();
  lead.enrichment_fields.employees = 900;
  lead.enrichment_fields.evidence[0]!.field_value = 900;
  lead.enrichment_fields.evidence[0]!.field_values!.employees = 900;
  lead.enrichment_fields.evidence.push({
    ...lead.enrichment_fields.evidence[0]!, evidence_id: "crm-employees", source_type: "crm", source_name: "HubSpot",
    eligible_for_crm_writeback: false, field_name: undefined, field_value: 500, field_values: { employees: 500 }
  });
  const store = storeFor(lead);
  const calls: unknown[] = [];
  try {
    const policy = { ...hubSpotWritebackPolicy, liveWritesEnabled: true, sourcePrecedence: ["enrichment", "crm", "public_signal"] as const };
    const written = await executeWriteback(planWriteback(lead, policy), {
      store, tenantId: "tenant-1", actorType: "system", actorId: "writeback-service", mode: "live", authorizedLiveWrite: true,
      write: async (call) => { calls.push(call); }
    });
    const audit = written.find(({ field_name }) => field_name === "numberofemployees")!;
    assert.equal(audit.actor_id, "writeback-service");
    const rollbackOptions = {
      store, tenantId: "tenant-1", actorType: "admin", actorId: "admin-1", policy, authorizedLiveWrite: true,
      write: async (call) => { calls.push(call); }
    } as const;
    await rollbackWriteback([audit.audit_id], rollbackOptions);
    assert.equal(store.getAuditRecord(`rollback:${audit.audit_id}`)?.actor_id, "admin-1");
    assert.equal(calls.length, written.length + 1);
    assert.deepEqual(calls.at(-1), { object: "company", objectId: lead.account_id, properties: { numberofemployees: 500 } });
    assert.throws(() => store.database.prepare("DELETE FROM rollback_links").run(), /append-only/i);
    assert.equal((store.database.prepare("SELECT count(*) AS count FROM writeback_audit_records WHERE field_name = 'numberofemployees'").get() as { count: number }).count, 2);
    assert.equal((await rollbackLeadWriteback(lead.evaluation_id, rollbackOptions)).length, written.length);
    assert.equal(calls.length, written.length * 2);
    assert.equal((store.database.prepare("SELECT count(*) AS count FROM rollback_links").get() as { count: number }).count, written.length);
    store.appendAuditRecord({
      auditId: "forged-owner", tenantId: "tenant-1", evaluationId: lead.evaluation_id, requestId: lead.request_id,
      crmObjectType: "company", crmObjectId: lead.account_id!, fieldName: "owner", sourceName: "test", sourceRef: "test",
      sourceUpdatedAt: lead.evaluation_timestamp, confidence: "High", outcome: "Written", reason: "forged",
      scoreVersion: lead.score_version, policyVersion: policy.version, actorType: "system"
    });
    await assert.rejects(rollbackWriteback(["forged-owner"], rollbackOptions), /policy-approved/i);
    assert.equal(calls.length, written.length * 2);
  } finally {
    store.close();
  }
});
