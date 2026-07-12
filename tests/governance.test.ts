import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { leads } from "../src/data/leads.ts";
import { createConfigDraft, defaultConfigVersion, defaultScoringConfig } from "../src/lib/config.ts";
import { RuntimeStore } from "../src/lib/persistence.ts";
import type { RequestIdentity } from "../src/lib/security.ts";
import { governanceReviewReasons } from "../src/lib/governance.ts";

const identity = (role: RequestIdentity["role"] = "revops_admin", requestId = "governance-request"): RequestIdentity => ({
  tenantId: "tenant-1", actorId: role === "rep" ? "rep-1" : "admin-1", role, requestId
});
const packet = (id: string) => structuredClone(leads.find(({ lead_id }) => lead_id === id)!);

test("RevOps can validate, compare, publish, and inspect immutable config history", () => {
  const store = new RuntimeStore(":memory:");
  try {
    store.saveTenant("tenant-1", "Pilot tenant");
    store.saveConfigVersion(identity(), defaultConfigVersion);
    const evaluated = packet("golden-normal");
    store.saveEvaluation({ tenantId: "tenant-1", idempotencyKey: "before-publish", packet: evaluated });

    const draft = createConfigDraft({
      ...defaultConfigVersion,
      id: "score-v0.2",
      author: "admin-1",
      createdAt: "2026-07-12T14:30:00.000Z",
      changeSummary: "Raise the Warm threshold.",
      adminNotes: "Pilot review complete.",
      config: { ...defaultScoringConfig, bandThresholds: { Cold: 0, Warm: 65, Hot: 80 } }
    });
    store.saveConfigVersion(identity(), draft);
    assert.throws(() => store.publishConfigDraft(identity("rep"), draft.id), /RevOps Admin/i);

    const published = store.publishConfigDraft(identity(), draft.id);
    assert.equal(published.published, true);
    assert.deepEqual(published.changedSections, ["bandThresholds"]);
    assert.equal(store.publishConfigDraft(identity(), draft.id).published, false);
    assert.deepEqual(store.listConfigVersions(identity()).map(({ id, status }) => ({ id, status })), [
      { id: "score-v0.2", status: "active" },
      { id: "score-v0.1", status: "inactive" }
    ]);
    assert.equal(store.getEvaluation(identity(), evaluated.evaluation_id)?.packet.score_version, "score-v0.1");
    assert.throws(() => store.database.prepare("DELETE FROM config_versions WHERE version_id = ?").run(draft.id), /immutable/i);
    assert.throws(() => store.database.prepare("UPDATE config_versions SET config_json = '{}' WHERE version_id = ?").run(draft.id), /immutable/i);

    const invalid = {
      ...draft,
      id: "invalid-config",
      status: "draft" as const,
      config: {
        ...draft.config,
        writeback: {
          ...draft.config.writeback,
          manualApprovalFields: { contact: ["owner"], company: [] }
        }
      }
    };
    assert.throws(() => store.saveConfigVersion(identity(), invalid as never), /manual approval fields/i);
  } finally {
    store.close();
  }
});

test("manual-review decisions are authorized, audited, idempotent, and visible", () => {
  const store = new RuntimeStore(":memory:");
  try {
    store.saveTenant("tenant-1", "Pilot tenant");
    store.saveConfigVersion(identity(), defaultConfigVersion);
    const reviewPacket = packet("no-usable-data");
    assert.ok(governanceReviewReasons(packet("small-high-intent")).includes("candidate_writeback_flagged"));
    assert.ok(governanceReviewReasons(packet("stale-writeback")).includes("stale_enrichment"));
    store.saveEvaluation({ tenantId: "tenant-1", idempotencyKey: "review", packet: reviewPacket });
    const open = store.listReviewItems(identity());
    assert.deepEqual(open.map((item) => item.reason).toSorted(), governanceReviewReasons(reviewPacket).toSorted());
    const reviewId = String((open[0] as { review_id: string }).review_id);
    assert.throws(() => store.decideReviewItem(identity("rep"), reviewId, "resolved", "Verified in CRM."), /RevOps Admin/i);
    assert.equal(store.decideReviewItem(identity(), reviewId, "resolved", "Verified in CRM.").changed, true);
    assert.equal(store.decideReviewItem(identity(), reviewId, "resolved", "Verified in CRM.").changed, false);
    assert.throws(() => store.decideReviewItem(identity(), reviewId, "dismissed", "Different decision."), /already closed/i);
    const resolved = store.listReviewItems(identity(), "resolved")[0] as { resolved_by: string; resolution_note: string };
    assert.equal(resolved.resolved_by, "admin-1");
    assert.equal(resolved.resolution_note, "Verified in CRM.");
    assert.ok((store.database.prepare("SELECT count(*) AS count FROM access_audit_records WHERE action = 'review.decide'").get() as { count: number }).count >= 3);
    assert.equal((store.database.prepare("SELECT count(*) AS count FROM access_audit_records WHERE action = 'review.decide' AND outcome = 'allowed'").get() as { count: number }).count, 2);
  } finally {
    store.close();
  }
});

test("governance audit and integration health expose pilot provenance without secrets", () => {
  const store = new RuntimeStore(":memory:");
  try {
    store.saveTenant("tenant-1", "Pilot tenant");
    store.saveConfigVersion(identity(), defaultConfigVersion);
    store.saveIntegration(identity(), { integrationId: "hubspot-1", provider: "hubspot", externalAccountId: "portal-1", status: "disabled" });
    const lead = packet("golden-normal");
    store.saveEvaluation({ tenantId: "tenant-1", idempotencyKey: "audit", packet: lead });
    store.appendAuditRecord(identity( "revops_admin", lead.request_id), {
      auditId: "audit-visible", evaluationId: lead.evaluation_id, requestId: lead.request_id,
      crmObjectType: "company", crmObjectId: lead.account_id!, fieldName: "numberofemployees",
      previousValue: 500, newValue: 900, sourceName: "EnrichmentProvider", sourceRef: "record-1",
      sourceUpdatedAt: lead.evaluation_timestamp, confidence: "High", outcome: "Written", reason: "Verified update",
      scoreVersion: lead.score_version, policyVersion: "hubspot-writeback-v0"
    });
    const audit = store.getGovernanceAudit(identity(), lead.evaluation_id)!;
    assert.equal((audit.evaluation as { score_version: string }).score_version, lead.score_version);
    assert.equal(audit.configVersion?.author, defaultConfigVersion.author);
    assert.ok(audit.evidence.length > 0);
    assert.ok(audit.claims.length > 0);
    assert.ok(audit.claimEvidence.length > 0);
    assert.equal((audit.writeback[0] as { actor_id: string }).actor_id, "admin-1");
    assert.equal((store.listRollbackCandidates(identity())[0] as { audit_id: string }).audit_id, "audit-visible");
    const integration = store.listIntegrationStatuses(identity())[0] as Record<string, unknown>;
    assert.deepEqual({ provider: integration.provider, status: integration.status, accessToken: integration.access_token_ciphertext }, { provider: "hubspot", status: "disabled", accessToken: undefined });
  } finally {
    store.close();
  }
});

test("admin UI exposes labeled config, review, audit, rollback, and integration controls", () => {
  const page = readFileSync(new URL("../src/pages/admin.astro", import.meta.url), "utf8");
  const server = readFileSync(new URL("../src/server.ts", import.meta.url), "utf8");
  for (const marker of ["Draft configuration", "Version history", "Manual-review queue", "Decision and writeback audit", "Integration health", "data-rollback-field", "data-rollback-lead"]) {
    assert.match(page, new RegExp(marker));
  }
  assert.match(page, /<label><span>Contact fields requiring approval<\/span>/);
  assert.match(page, /role="alert"/);
  assert.match(page, /aria-live="polite"/);
  assert.match(page, /api\(`\/admin\/reviews\/\$\{encodeURIComponent\(item\.dataset\.reviewId!\)\}\/decision`/);
  assert.match(page, /contextai\.session-token/);
  assert.match(page, /api<\{ versions: Version\[\] \}>\("\/admin\/config"\)/);
  assert.match(page, /api<\{ reviews: Review\[\] \}>\("\/admin\/reviews"\)/);
  assert.match(page, /dataset\.rollback/);
  assert.match(server, /authenticateBearer\(request\.headers\.authorization\)/);
  assert.match(server, /store\.decideReviewItem/);
  assert.match(server, /store\.publishConfigDraft/);
  assert.match(server, /rollbackWriteback/);
});
