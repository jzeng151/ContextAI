import assert from "node:assert/strict";
import test from "node:test";
import { leads } from "../src/data/leads.ts";
import { assertLeadPacket, hasOnlyWeakOpenIntent, type LeadPacket } from "../src/lib/contextai.ts";
import {
  configBoundaryFixtures,
  createScoringRunContext,
  defaultConfigVersion,
  defaultScoringConfig,
} from "../src/lib/config.ts";
import {
  applyDeterministicScore,
  bandForScore,
  requiresManualReview,
  scoreLead,
} from "../src/lib/scoring.ts";

const context = createScoringRunContext(defaultConfigVersion);
const byId = (id: string) => {
  const lead = leads.find((item) => item.lead_id === id);
  if (!lead) throw new Error(id);
  return lead;
};
const contextWith = (id: string, config: typeof defaultScoringConfig) =>
  createScoringRunContext({ ...defaultConfigVersion, id, config });
const scoreTotal = (lead: ReturnType<typeof scoreLead>) =>
  Object.values(lead.score_breakdown).reduce((sum, value) => sum + value, 0);
const sourceDate = (lead: LeadPacket, daysAgo: number) =>
  new Date(Date.parse(lead.evaluation_timestamp) - daysAgo * 24 * 60 * 60 * 1000).toISOString();

test("current fixtures are rescored with the active context and still satisfy LeadPacket", () => {
  for (const lead of leads) {
    const scored = scoreLead(lead, context);
    assert.doesNotThrow(() => assertLeadPacket(lead), lead.lead_id);
    assert.deepEqual(
      {
        score_version: lead.score_version,
        priority_score: lead.priority_score,
        priority_band: lead.priority_band,
        confidence: lead.confidence,
        manual_review_reasons: lead.manual_review_reasons,
        score_breakdown: lead.score_breakdown,
        top_drivers: lead.top_drivers,
      },
      scored,
      lead.lead_id,
    );
  }
});

test("default fixture scores remain stable after the #11 field split", () => {
  const expected = {
    "golden-normal": [94, "Hot", "High"],
    "small-high-intent": [50, "Cold", "Medium"],
    "no-usable-data": [null, "Needs Manual Review", "Low"],
    "no-public-signal": [83, "Hot", "High"],
    "weak-opens": [54, "Cold", "Medium"],
    "stale-writeback": [null, "Needs Manual Review", "Low"],
  } as const;
  for (const lead of leads) {
    assert.deepEqual([lead.priority_score, lead.priority_band, lead.confidence], expected[lead.lead_id as keyof typeof expected]);
  }
});

test("score version, weights, caps, and bands come from the explicit run context", () => {
  const custom = contextWith("score-custom", {
    ...defaultScoringConfig,
    categoryWeights: {
      ...defaultScoringConfig.categoryWeights,
      public_timing_signals: 5,
      crm_process_context: 20,
    },
    bandThresholds: { Cold: 0, Warm: 70, Hot: 95 },
  });
  const scored = scoreLead(byId("golden-normal"), custom);
  assert.equal(scored.score_version, "score-custom");
  assert.deepEqual(scored.score_breakdown, {
    icp_fit: 30,
    high_intent_actions: 25,
    engagement_quality: 14,
    public_timing_signals: 5,
    crm_process_context: 10,
    data_confidence: 5,
  });
  assert.equal(scored.priority_score, 89);
  assert.equal(scored.priority_band, "Warm");
  for (const [category, points] of Object.entries(scored.score_breakdown)) {
    assert.ok(points <= custom.config.categoryWeights[category as keyof typeof custom.config.categoryWeights]);
  }
});

test("fractional category caps preserve the exact LeadPacket score sum", () => {
  const fractional = contextWith("score-fractional", {
    ...defaultScoringConfig,
    categoryWeights: {
      icp_fit: 50.68,
      high_intent_actions: 15.53,
      engagement_quality: 19.59,
      public_timing_signals: 8.47,
      crm_process_context: 1.81,
      data_confidence: 3.92,
    },
  });
  const scored = applyDeterministicScore(byId("golden-normal"), fractional);
  assert.equal(scored.priority_score, Object.values(scored.score_breakdown).reduce((sum, points) => sum + points, 0));
  assert.doesNotThrow(() => assertLeadPacket(scored));

  const allCap = structuredClone(byId("golden-normal"));
  allCap.crm_context.source = "Intent surge";
  allCap.crm_context.evidence[0].field_values = { routing_status: "open", source: "Intent surge" };
  allCap.engagement_signals.replies = 1;
  allCap.engagement_signals.evidence[0].field_values = {
    ...allCap.engagement_signals.evidence[0].field_values,
    replies: 1,
  };
  const floatingTotal = contextWith("score-floating-total", {
    ...defaultScoringConfig,
    categoryWeights: {
      icp_fit: 49.05,
      high_intent_actions: 31.37,
      engagement_quality: 5.45,
      public_timing_signals: 7.59,
      crm_process_context: 4.5,
      data_confidence: 2.04,
    },
    bandThresholds: { Cold: 0, Warm: 60, Hot: 100 },
  });
  const normalized = applyDeterministicScore(allCap, floatingTotal);
  assert.equal(normalized.priority_score, 100);
  assert.equal(normalized.priority_band, "Hot");
  assert.equal(normalized.priority_score, Object.values(normalized.score_breakdown).reduce((sum, points) => sum + points, 0));
  assert.equal(normalized.confidence, "High");
  assert.doesNotThrow(() => assertLeadPacket(normalized));
});

test("configured band boundaries are inclusive", () => {
  for (const fixture of configBoundaryFixtures.scoreBands) {
    assert.equal(bandForScore(fixture.score, context), fixture.expectedBand, String(fixture.score));
  }
  const custom = contextWith("score-bands", {
    ...defaultScoringConfig,
    bandThresholds: { Cold: 0, Warm: 40, Hot: 50 },
  });
  assert.deepEqual([39, 40, 49, 50].map((score) => bandForScore(score, custom)), ["Cold", "Warm", "Warm", "Hot"]);
});

test("ICP headcount boundaries use the configured category cap", () => {
  const base = byId("small-high-intent");
  for (const [employees, expected] of [[19, 10], [20, 15], [49, 15], [50, 20], [99, 20], [100, 25]] as const) {
    const lead = structuredClone(base);
    lead.enrichment_fields.employees = employees;
    lead.enrichment_fields.evidence[0].field_values = { employees };
    assert.equal(scoreLead(lead, context).score_breakdown.icp_fit, expected, String(employees));
  }
});

test("public-signal timing boundaries honor configured freshness", () => {
  const base = byId("golden-normal");
  for (const [daysAgo, expected] of [[14, 15], [15, 12], [30, 12], [31, 8], [90, 8], [91, 0]] as const) {
    const lead = structuredClone(base);
    lead.public_signals[0].days_ago = daysAgo;
    lead.public_signals[0].evidence[0].source_published_at = sourceDate(lead, daysAgo);
    assert.equal(scoreLead(lead, context).score_breakdown.public_timing_signals, expected, String(daysAgo));
  }
});

test("intent surge and engagement actions remain separate score inputs", () => {
  const surge = scoreLead(byId("small-high-intent"), context);
  assert.equal(surge.score_breakdown.high_intent_actions, 25);
  assert.equal(surge.score_breakdown.engagement_quality, 0);

  const engagement = scoreLead(byId("golden-normal"), context);
  assert.equal(byId("golden-normal").intent_signals.surge, false);
  assert.equal(engagement.score_breakdown.high_intent_actions, 25);
  assert.equal(engagement.score_breakdown.engagement_quality, 14);
});

test("stale intent evidence stops contributing after the active freshness boundary", () => {
  const lead = structuredClone(byId("small-high-intent"));
  lead.intent_signals.evidence[0].source_updated_at = sourceDate(lead, context.config.freshness.intent.freshThroughDays + 1);
  assert.equal(scoreLead(lead, context).score_breakdown.high_intent_actions, 0);
});

test("stale-only behavior cannot replace missing required firmographics", () => {
  const lead = structuredClone(byId("small-high-intent"));
  lead.enrichment_fields = { tech_stack: [], evidence: [] };
  lead.intent_signals.evidence[0].source_updated_at = sourceDate(lead, context.config.freshness.intent.freshThroughDays + 1);
  lead.manual_review_reasons = [];
  const scored = scoreLead(lead, context);
  assert.ok(scored.manual_review_reasons.includes("missing_required_data"));
  assert.equal(scored.priority_score, null);
});

test("stale scored signals deterministically lower confidence", () => {
  const lead = structuredClone(byId("golden-normal"));
  lead.engagement_signals.evidence[0].source_updated_at = sourceDate(lead, context.config.freshness.engagement.freshThroughDays + 1);
  const scored = scoreLead(lead, context);
  assert.equal(scored.score_breakdown.high_intent_actions, 0);
  assert.equal(scored.score_breakdown.engagement_quality, 0);
  assert.equal(scored.confidence, "Medium");
});

test("more stale source families than configured produce Low confidence", () => {
  const lead = structuredClone(byId("golden-normal"));
  lead.engagement_signals.evidence[0].source_updated_at = sourceDate(lead, context.config.freshness.engagement.freshThroughDays + 1);
  lead.public_signals[0].days_ago = context.config.freshness.publicSignal.freshThroughDays + 1;
  lead.public_signals[0].evidence[0].source_published_at = sourceDate(lead, lead.public_signals[0].days_ago);
  assert.equal(scoreLead(lead, context).confidence, "Low");
});

test("manual-review reasons are derived and take precedence over numeric bands", () => {
  const cases: Array<[string, LeadPacket, string]> = [];
  const golden = byId("golden-normal");

  cases.push(["conflict", { ...golden, source_conflicts: ["material conflict"] }, "source_conflict"]);
  cases.push(["identity", {
    ...golden,
    crm_context: { ...golden.crm_context, domain_status: "unresolved" },
  }, "uncertain_identity"]);
  cases.push(["duplicate", {
    ...golden,
    crm_context: { ...golden.crm_context, duplicate_status: "suspected" },
  }, "duplicate_risk"]);
  cases.push(["association", {
    ...golden,
    account_id: null,
    crm_context: {
      ...golden.crm_context,
      company_association: { status: "ambiguous", basis: null, candidate_account_ids: ["acct-a", "acct-b"] },
    },
  }, "ambiguous_account"]);

  const missing = structuredClone(byId("weak-opens"));
  missing.enrichment_fields = { tech_stack: [], evidence: [] };
  missing.intent_signals = { surge: false, evidence: [] };
  missing.engagement_signals = { opens: 0, clicks: 0, replies: 0, demo_request: false, pricing_page_visit: false, evidence: [] };
  missing.manual_review_reasons = [];
  cases.push(["missing", missing, "missing_required_data"]);

  const malformed = structuredClone(golden);
  malformed.enrichment_fields.employees = -1;
  malformed.enrichment_fields.evidence[0].field_values = {
    ...malformed.enrichment_fields.evidence[0].field_values,
    employees: -1,
  };
  cases.push(["malformed", malformed, "invalid_source_result"]);

  cases.push(["invalid source", {
    ...golden,
    tool_status: {
      ...golden.tool_status,
      enrich_profile: { status: "invalid_result", completed_at: golden.evaluation_timestamp, detail: "Malformed provider result." },
    },
  }, "invalid_source_result"]);
  cases.push(["scorer unavailable", {
    ...golden,
    tool_status: {
      ...golden.tool_status,
      deterministic_score: { status: "timeout", completed_at: golden.evaluation_timestamp, detail: "Scorer timed out." },
    },
  }, "scoring_unavailable"]);
  cases.push(["upstream unsafe workflow", {
    ...golden,
    manual_review_reasons: ["unsafe_workflow_state"],
  }, "unsafe_workflow_state"]);

  for (const [name, lead, reason] of cases) {
    const scored = scoreLead(lead, context);
    assert.equal(requiresManualReview(lead, context), true, name);
    assert.ok(scored.manual_review_reasons.includes(reason as never), name);
    assert.equal(scored.priority_score, null, name);
    assert.equal(scored.priority_band, "Needs Manual Review", name);
    assert.equal(scored.confidence, "Low", name);
    assert.deepEqual(Object.values(scored.score_breakdown), [0, 0, 0, 0, 0, 0], name);
    assert.deepEqual(scored.top_drivers, [], name);
  }
});

test("Low-confidence enrichment earns no data-confidence points", () => {
  const lead = structuredClone(byId("golden-normal"));
  lead.enrichment_fields.evidence[0].confidence = "Low";
  const scored = scoreLead(lead, context);
  assert.equal(scored.score_breakdown.data_confidence, 0);
  assert.equal(scored.confidence, "Low");
  assert.notEqual(scored.priority_score, null);
});

test("Low-confidence scored signal evidence lowers overall confidence", () => {
  const cases = [
    ["intent", byId("small-high-intent"), (lead: LeadPacket) => { lead.intent_signals.evidence[0].confidence = "Low"; }],
    ["engagement", byId("golden-normal"), (lead: LeadPacket) => { lead.engagement_signals.evidence[0].confidence = "Low"; }],
    ["public", byId("golden-normal"), (lead: LeadPacket) => { lead.public_signals[0].evidence[0].confidence = "Low"; }],
  ] as const;
  for (const [name, source, lower] of cases) {
    const lead = structuredClone(source);
    lower(lead);
    const scored = scoreLead(lead, context);
    assert.equal(scored.confidence, "Low", name);
    assert.notEqual(scored.priority_score, null, name);
  }
});

test("stale enrichment degrades points and confidence without forcing manual review", () => {
  const medium = structuredClone(byId("golden-normal"));
  medium.enrichment_fields.last_updated_days_ago = 100;
  medium.enrichment_fields.evidence[0].source_updated_at = sourceDate(medium, 100);
  const mediumScore = scoreLead(medium, context);
  assert.equal(mediumScore.score_breakdown.data_confidence, 2);
  assert.equal(mediumScore.confidence, "Medium");
  assert.notEqual(mediumScore.priority_score, null);

  const low = structuredClone(byId("golden-normal"));
  low.enrichment_fields.last_updated_days_ago = 181;
  low.enrichment_fields.evidence[0].source_updated_at = sourceDate(low, 181);
  const lowScore = scoreLead(low, context);
  assert.equal(lowScore.score_breakdown.data_confidence, 0);
  assert.equal(lowScore.confidence, "Low");
  assert.notEqual(lowScore.priority_score, null);
});

test("employee evidence age, not an unrelated fresh enrichment, controls data confidence", () => {
  const lead = structuredClone(byId("golden-normal"));
  const employee = lead.enrichment_fields.evidence[0];
  employee.source_updated_at = sourceDate(lead, 181);
  employee.field_values = { employees: lead.enrichment_fields.employees! };
  const freshFirmographics = {
    ...employee,
    evidence_id: "gn-fresh-firmographics",
    field_name: undefined,
    field_value: lead.enrichment_fields.revenue_band!,
    field_values: {
      revenue_band: lead.enrichment_fields.revenue_band!,
      tech_stack: lead.enrichment_fields.tech_stack,
    },
    source_updated_at: sourceDate(lead, 0),
    eligible_for_crm_writeback: false,
  };
  lead.enrichment_fields.evidence.push(freshFirmographics);
  lead.enrichment_fields.last_updated_days_ago = 0;
  const scored = applyDeterministicScore(lead, context);
  assert.equal(scored.score_breakdown.data_confidence, 0);
  assert.equal(scored.confidence, "Low");
  assert.doesNotThrow(() => assertLeadPacket(scored));
});

test("future-dated scoring evidence is malformed and requires review", () => {
  const lead = structuredClone(byId("golden-normal"));
  lead.enrichment_fields.evidence[0].source_updated_at = sourceDate(lead, -1);
  const scored = scoreLead(lead, context);
  assert.ok(scored.manual_review_reasons.includes("invalid_source_result"));
  assert.equal(scored.priority_score, null);

  const invalidDate = structuredClone(byId("golden-normal"));
  invalidDate.engagement_signals.evidence[0].source_updated_at = "not-a-date";
  assert.ok(scoreLead(invalidDate, context).manual_review_reasons.includes("invalid_source_result"));
});

test("higher-precedence CRM firmographics cannot be bypassed by enrichment", () => {
  const lead = structuredClone(byId("golden-normal"));
  lead.enrichment_fields.evidence.push({
    ...lead.enrichment_fields.evidence[0],
    evidence_id: "gn-crm-employees",
    source_name: "HubSpot",
    source_type: "crm",
    field_name: undefined,
    field_value: 75,
    field_values: { employees: 75 },
    source_updated_at: sourceDate(lead, 0),
    eligible_for_crm_writeback: false,
  });
  const scored = scoreLead(lead, context);
  assert.ok(scored.manual_review_reasons.includes("source_conflict"));
  assert.equal(scored.priority_score, null);
  const applied = applyDeterministicScore(lead, context);
  assert.ok(applied.source_conflicts.length > 0);
  assert.equal(applied.writeback_plan?.decision, "Review");
  assert.doesNotThrow(() => assertLeadPacket(applied));
});

test("older same-source firmographics do not override the newest evidence", () => {
  const lead = structuredClone(byId("golden-normal"));
  lead.enrichment_fields.evidence.push({
    ...lead.enrichment_fields.evidence[0],
    evidence_id: "gn-old-clearbit-employees",
    field_name: undefined,
    field_value: 75,
    field_values: { employees: 75 },
    source_updated_at: sourceDate(lead, 100),
    eligible_for_crm_writeback: false,
  });
  const scored = scoreLead(lead, context);
  assert.deepEqual(scored.manual_review_reasons, []);
  assert.equal(scored.score_breakdown.icp_fit, 30);
});

test("applying a derived manual-review score cannot leave writeback Eligible", () => {
  const lead = structuredClone(byId("golden-normal"));
  lead.crm_context.duplicate_status = "suspected";
  const scored = applyDeterministicScore(lead, context);
  assert.equal(scored.priority_band, "Needs Manual Review");
  assert.equal(scored.writeback_plan?.decision, "Review");
  assert.doesNotThrow(() => assertLeadPacket(scored));
});

test("weak opens cannot be the points that produce Hot under an active threshold", () => {
  const weak = byId("weak-opens");
  assert.equal(hasOnlyWeakOpenIntent(weak), true);
  const custom = contextWith("score-weak-opens", {
    ...defaultScoringConfig,
    bandThresholds: { Cold: 0, Warm: 40, Hot: 50 },
  });
  const scored = scoreLead(weak, custom);
  assert.equal(scored.priority_score, 44);
  assert.equal(scored.priority_band, "Warm");
  assert.equal(scored.score_breakdown.engagement_quality, 0);
  assert.equal(scored.priority_score, scoreTotal(scored));
});

test("stale stronger signals cannot bypass the weak-open Hot guard", () => {
  const lead = structuredClone(byId("weak-opens"));
  lead.engagement_signals.clicks = 1;
  lead.engagement_signals.evidence.push({
    ...lead.engagement_signals.evidence[0],
    evidence_id: "wo-stale-click",
    field_value: "1 stale click",
    field_values: { clicks: 1 },
    source_updated_at: sourceDate(lead, context.config.freshness.engagement.freshThroughDays + 1),
  });
  const custom = contextWith("score-stale-click", {
    ...defaultScoringConfig,
    bandThresholds: { Cold: 0, Warm: 40, Hot: 49 },
  });
  const scored = scoreLead(lead, custom);
  assert.equal(scored.priority_score, 44);
  assert.equal(scored.priority_band, "Warm");
});

test("weak opens do not demote a lead whose other drivers already produce Hot", () => {
  const lead = structuredClone(byId("golden-normal"));
  lead.engagement_signals = {
    opens: 1,
    clicks: 0,
    replies: 0,
    demo_request: false,
    pricing_page_visit: false,
    evidence: [{
      ...lead.engagement_signals.evidence[0],
      field_value: "1 email open",
      field_values: { opens: 1 },
    }],
  };
  const custom = contextWith("score-fit-hot", {
    ...defaultScoringConfig,
    bandThresholds: { Cold: 0, Warm: 40, Hot: 50 },
  });
  const scored = scoreLead(lead, custom);
  assert.equal(scored.priority_score, 57);
  assert.equal(scored.priority_band, "Hot");
});

test("adding eligible engagement cannot lower engagement quality", () => {
  const weak = byId("weak-opens");
  const stronger = structuredClone(weak);
  stronger.engagement_signals.clicks = 1;
  stronger.engagement_signals.evidence[0].field_value = "5 opens and 1 click";
  stronger.engagement_signals.evidence[0].field_values = { opens: 5, clicks: 1 };
  assert.ok(scoreLead(stronger, context).score_breakdown.engagement_quality >= scoreLead(weak, context).score_breakdown.engagement_quality);
});

test("closed or unsupported CRM state evidence earns no CRM points", () => {
  const closed = structuredClone(byId("golden-normal"));
  closed.crm_context.routing_status = "closed";
  closed.crm_context.evidence[0].field_value = "Closed";
  closed.crm_context.evidence[0].field_values = { routing_status: "closed", source: "Inbound demo" };
  assert.equal(scoreLead(closed, context).score_breakdown.crm_process_context, 0);

  const unsupported = structuredClone(byId("golden-normal"));
  unsupported.crm_context.evidence[0].field_values = { routing_status: "open", source: "Different source" };
  assert.equal(scoreLead(unsupported, context).score_breakdown.crm_process_context, 0);
});

test("stale public evidence is excluded from drivers and confidence", () => {
  const lead = structuredClone(byId("golden-normal"));
  lead.public_signals[0].evidence.push({
    ...lead.public_signals[0].evidence[0],
    evidence_id: "gn-stale-public",
    confidence: "Low",
    source_published_at: sourceDate(lead, context.config.freshness.publicSignal.freshThroughDays + 1),
  });
  const scored = applyDeterministicScore(lead, context);
  const driver = scored.top_drivers.find((item) => item.category === "public_timing_signals");
  assert.ok(driver);
  assert.deepEqual(driver.evidence_ids, ["gn-public-series-b"]);
  assert.equal(scored.confidence, "High");
  assert.doesNotThrow(() => assertLeadPacket(scored));
});

test("obsolete derived manual reasons do not stick after data is repaired", () => {
  const lead = structuredClone(byId("weak-opens"));
  lead.manual_review_reasons = ["missing_required_data"];
  const scored = scoreLead(lead, context);
  assert.deepEqual(scored.manual_review_reasons, []);
  assert.equal(scored.priority_score, 54);
});

test("every nonzero driver is sorted and backed by packet evidence", () => {
  const lead = byId("golden-normal");
  const scored = scoreLead(lead, context);
  const evidenceIds = new Set([
    ...lead.crm_context.evidence,
    ...lead.enrichment_fields.evidence,
    ...lead.intent_signals.evidence,
    ...lead.engagement_signals.evidence,
    ...lead.public_signals.flatMap((signal) => signal.evidence),
  ].map((item) => item.evidence_id));
  const nonzero = Object.entries(scored.score_breakdown).filter(([, points]) => points > 0).map(([category]) => category).sort();
  assert.deepEqual(scored.top_drivers.map((driver) => driver.category).sort(), nonzero);
  assert.deepEqual(scored.top_drivers.map((driver) => driver.points), [...scored.top_drivers.map((driver) => driver.points)].sort((a, b) => b - a));
  for (const driver of scored.top_drivers) {
    assert.ok(driver.evidence_ids.length > 0, driver.category);
    assert.ok(driver.evidence_ids.every((id) => evidenceIds.has(id)), driver.category);
  }
  assert.equal(scored.priority_score, scoreTotal(scored));
});

test("scoring and re-scoring are stable and side-effect free", () => {
  const lead = structuredClone(byId("golden-normal"));
  const before = structuredClone(lead);
  assert.deepEqual(scoreLead(lead, context), scoreLead(lead, context));
  assert.deepEqual(lead, before);

  const once = applyDeterministicScore(lead, context);
  const twice = applyDeterministicScore(once, context);
  assert.deepEqual(twice, once);
});
