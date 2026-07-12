import assert from "node:assert/strict";
import test from "node:test";
import { createConfigDraft, createScoringRunContext, defaultConfigVersion } from "../src/lib/config.ts";
import type { Evidence } from "../src/lib/contextai.ts";
import { evaluateLead, handleAssignmentEvent, mapHubSpotLead, parseHubSpotAssignmentEvents, verifyAssignmentSignature } from "../src/lib/orchestration.ts";
import { RuntimeStore } from "../src/lib/persistence.ts";
import { createHmac } from "node:crypto";

const at = "2026-07-12T09:00:00.000Z";
const identity = { requestId: "orchestration-test", tenantId: "tenant-15", actorId: "admin-15", role: "revops_admin" as const };
const record = {
  id: "contact-15",
  firstname: "Ada",
  lastname: "Lovelace",
  email: "ada@example.com",
  jobtitle: "VP Operations",
  owner: "rep-1",
  source: "Inbound",
  lifecycleStage: "lead",
  routingStatus: "open",
  openOpportunityStatus: "none" as const,
  duplicateStatus: "clear" as const,
  companies: [{ id: "company-15", name: "Example", domain: "example.com", primary: true }],
  updatedAt: "2026-07-01T09:00:00.000Z",
};

const evidence: Evidence = {
  evidence_id: "enrichment-15",
  source_name: "Fixture enrichment",
  source_type: "enrichment",
  field_name: "employees",
  field_value: 500,
  field_values: { employees: 500 },
  source_record_id: "company-15",
  source_updated_at: "2026-07-10T09:00:00.000Z",
  retrieved_at: at,
  confidence: "High",
  eligible_for_crm_writeback: true,
};

const dependencies = (intentStatus: "no_result" | "timeout" = "no_result") => ({
  getCrmLead: async () => record,
  enrich: async () => ({ status: "success" as const, employees: 500, tech_stack: [], last_updated: "2026-07-10T09:00:00.000Z", confidence: "High" as const, source_name: "Fixture enrichment", evidence: [evidence] }),
  intent: async () => ({ status: intentStatus, opens: 0, clicks: 0, replies: 0, demo_request: false, pricing_page_visit: false, surge: false, confidence: "Low" as const, source_name: "Fixture intent", evidence: [], ...(intentStatus === "timeout" ? { message: "Provider timed out." } : { message: "No signals." }) }),
  publicSignals: async () => ({ status: "no_result" as const, signals: [], evidence: [], message: "No signals." }),
});

const setup = () => {
  const store = new RuntimeStore(":memory:");
  store.saveTenant("tenant-15", "Issue 15 fixture");
  store.saveConfigVersion(identity, defaultConfigVersion);
  return store;
};

test("ordered evaluation persists a complete run and replay is idempotent", async () => {
  const store = setup();
  const options = { identity, idempotencyKey: "assignment:event-15", contactId: record.id, store, dependencies: dependencies(), scoringContext: createScoringRunContext(defaultConfigVersion), requestId: "event-15", evaluatedAt: at };
  const first = await evaluateLead(options);
  const replay = await evaluateLead(options);

  assert.equal(first.replayed, false);
  assert.equal(first.packet.priority_band === "Needs Manual Review", false);
  assert.equal(first.packet.tool_status.deterministic_score.status, "success");
  assert.equal(first.packet.tool_status.evaluate_crm_writeback.status, "success", first.packet.tool_status.evaluate_crm_writeback.detail);
  assert.equal(first.outcome, "complete");
  assert.equal(store.database.prepare("SELECT count(*) AS count FROM writeback_audit_records").get().count, 1);
  assert.equal(store.database.prepare("SELECT count(*) AS count FROM events").get().count, 2);
  assert.equal(replay.replayed, true);
  assert.equal(replay.packet.evaluation_id, first.packet.evaluation_id);
  assert.equal(store.database.prepare("SELECT count(*) AS count FROM evaluation_runs").get().count, 1);
  store.close();
});

test("new evaluations use the tenant's published active configuration", async () => {
  const store = setup();
  const draft = createConfigDraft({
    ...defaultConfigVersion,
    id: "score-v0.2",
    author: "admin-15",
    createdAt: "2026-07-12T08:00:00.000Z",
    changeSummary: "Publish pilot scoring policy.",
    adminNotes: "Verified before the morning run.",
    config: {
      ...defaultConfigVersion.config,
      writeback: {
        ...defaultConfigVersion.config.writeback,
        manualApprovalFields: { contact: [], company: ["company_size_band"] }
      }
    }
  });
  store.saveConfigVersion(identity, draft);
  store.publishConfigDraft(identity, draft.id);

  const result = await evaluateLead({ identity, idempotencyKey: "active-config-15", contactId: record.id, store, dependencies: dependencies(), evaluatedAt: at });
  assert.equal(result.packet.score_version, draft.id);
  assert.equal(result.packet.writeback_plan?.decision, "Review");
  assert.ok(store.listReviewItems(identity).some((item) => item.reason === "candidate_writeback_flagged"));
  assert.equal(store.getGovernanceAudit(identity, result.packet.evaluation_id)?.configVersion?.id, draft.id);
  store.close();
});

test("concurrent trigger delivery creates one evaluation and one grounding audit", async () => {
  const store = setup();
  const options = { identity, idempotencyKey: "concurrent-15", contactId: record.id, store, dependencies: dependencies(), evaluatedAt: at };
  const results = await Promise.all([evaluateLead(options), evaluateLead(options)]);
  assert.equal(new Set(results.map(({ packet }) => packet.evaluation_id)).size, 1);
  assert.equal(store.database.prepare("SELECT count(*) AS count FROM evaluation_runs").get().count, 1);
  assert.equal(store.database.prepare("SELECT count(*) AS count FROM grounding_audit_records").get().count, 1);
  store.close();
});

test("optional source failure remains terminal and safely continues", async () => {
  const store = setup();
  const result = await evaluateLead({ identity, idempotencyKey: "failure-15", contactId: record.id, store, dependencies: dependencies("timeout"), evaluatedAt: at });

  assert.equal(result.packet.tool_status.fetch_intent_triggers.status, "timeout");
  assert.equal(result.packet.tool_status.deterministic_score.status, "success");
  assert.equal(result.outcome, "partial_failure");
  store.close();
});

test("scoring failure never invokes the LLM and creates a review item", async () => {
  const store = setup();
  let explained = false;
  const result = await evaluateLead({
    identity, idempotencyKey: "score-failure-15", contactId: record.id, store, evaluatedAt: at,
    dependencies: { ...dependencies(), score: () => { throw new Error("Score service unavailable"); }, explain: async () => { explained = true; throw new Error("must not run"); } },
  });

  assert.equal(explained, false);
  assert.equal(result.packet.tool_status.deterministic_score.status, "unavailable");
  assert.equal(result.packet.tool_status.evaluate_crm_writeback.status, "skipped");
  assert.deepEqual(result.packet.manual_review_reasons, ["scoring_unavailable"]);
  assert.equal(store.database.prepare("SELECT count(*) AS count FROM review_items").get().count, 1);
  store.close();
});

test("ambiguous associations route to manual review with reason evidence", () => {
  const packet = mapHubSpotLead({ ...record, companies: [{ id: "a", name: "A", domain: "a.example" }, { id: "b", name: "B", domain: "b.example" }] }, { requestId: "request", evaluationId: "evaluation" }, at, defaultConfigVersion.id);
  assert.equal(packet.account_id, null);
  assert.equal(packet.crm_context.company_association.status, "ambiguous");
  assert.equal(packet.validation_evidence[0]?.field_values?.manual_review_reason, "ambiguous_account");
});

test("assignment events require valid shape and signatures are constant-time checked", async () => {
  const raw = JSON.stringify({ eventId: "event-15" });
  const signature = createHmac("sha256", "secret").update(raw).digest("hex");
  assert.equal(verifyAssignmentSignature(raw, signature, "secret"), true);
  assert.equal(verifyAssignmentSignature(raw, "00", "secret"), false);
  assert.deepEqual(parseHubSpotAssignmentEvents([{ eventId: 15, objectId: 20, propertyName: "hubspot_owner_id", propertyValue: "rep-1", occurredAt: Date.parse(at) }], "tenant-15")[0], {
    eventId: "15", tenantId: "tenant-15", contactId: "20", ownerId: "rep-1", occurredAt: at, type: "reassignment",
  });

  const store = setup();
  await assert.rejects(() => handleAssignmentEvent({ eventId: "", tenantId: "tenant-15", contactId: record.id, ownerId: "rep-1", occurredAt: at, type: "new_owner" }, { identity, store, dependencies: dependencies() }), /Malformed assignment event/);
  await assert.rejects(() => handleAssignmentEvent({ eventId: "event-cross-tenant", tenantId: "tenant-other", contactId: record.id, ownerId: "rep-1", occurredAt: at, type: "reassignment" }, { identity, store, dependencies: dependencies() }), /Cross-tenant access denied/);
  store.close();
});
