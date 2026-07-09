import assert from "node:assert/strict";
import test from "node:test";
import { leads } from "../src/data/leads.ts";
import { groundedHook, hasOnlyWeakOpenIntent, isWritebackEligible } from "../src/lib/contextai.ts";
import { explainLeadWithOpenRouter, hubSpotConfigFromEnv, listHubSpotContacts, openRouterConfigFromEnv } from "../src/lib/integrations.ts";

test("stale enrichment is not eligible for CRM writeback", () => {
  const lead = leads.find((item) => item.lead_id === "stale-writeback");
  assert.ok(lead);
  assert.equal(isWritebackEligible(lead), false);
});

test("email opens alone stay weak", () => {
  const lead = leads.find((item) => item.lead_id === "weak-opens");
  assert.ok(lead);
  assert.equal(hasOnlyWeakOpenIntent(lead), true);
  assert.notEqual(lead.priority_band, "Hot");
  assert.match(lead.reason, /opens alone are not reliable buying intent/i);
});

test("missing public signal uses grounded hook fallback", () => {
  const lead = leads.find((item) => item.lead_id === "no-public-signal");
  assert.ok(lead);
  assert.equal(groundedHook(lead), "No grounded hook available - no recent verified signal found.");
});

test("non-hook allowed claims do not ground hooks", () => {
  const lead = leads.find((item) => item.lead_id === "weak-opens");
  assert.ok(lead);
  assert.equal(groundedHook({ ...lead, hook: "Reference the observed email opens." }), "No grounded hook available - no recent verified signal found.");
});

test("intent evidence does not ground arbitrary hooks", () => {
  const lead = leads.find((item) => item.lead_id === "no-public-signal");
  assert.ok(lead);
  assert.equal(lead.intent_signals.demo_request, true);
  assert.equal(lead.intent_signals.pricing_page_visit, true);
  assert.equal(groundedHook({ ...lead, hook: "Reference recent public expansion news." }), "No grounded hook available - no recent verified signal found.");
});

test("public evidence must match the hook text", () => {
  const lead = leads.find((item) => item.lead_id === "golden-normal");
  assert.ok(lead);
  assert.equal(groundedHook({ ...lead, hook: "Reference recent public expansion news." }), "No grounded hook available - no recent verified signal found.");
});

test("writeback eligibility requires high-confidence eligible enrichment evidence", () => {
  const lead = leads.find((item) => item.lead_id === "no-public-signal");
  assert.ok(lead);
  assert.equal(isWritebackEligible(lead), true);
  assert.equal(
    isWritebackEligible({
      ...lead,
      enrichment_fields: {
        ...lead.enrichment_fields,
        evidence: lead.enrichment_fields.evidence.map((item) => ({
          ...item,
          confidence: "Medium",
          eligible_for_crm_writeback: false
        }))
      }
    }),
    false
  );
});

test("writeback eligibility requires fresh enrichment evidence dates", () => {
  const lead = leads.find((item) => item.lead_id === "no-public-signal");
  assert.ok(lead);
  assert.equal(
    isWritebackEligible({
      ...lead,
      enrichment_fields: {
        ...lead.enrichment_fields,
        last_updated_days_ago: 1,
        evidence: lead.enrichment_fields.evidence.map((item) => ({
          ...item,
          source_updated_at: "2026-01-01T09:00:00.000Z"
        }))
      }
    }),
    false
  );
});

test("fixtures include required lead packet contract fields", () => {
  for (const lead of leads) {
    assert.ok(lead.lead_id);
    assert.ok(lead.account_id);
    assert.ok(lead.evaluation_timestamp);
    assert.ok(lead.score_version);
    assert.ok(lead.lead_identity.email);
    assert.ok(lead.crm_context.owner);
    assert.ok(Array.isArray(lead.allowed_claims));
    assert.ok(Array.isArray(lead.disallowed_claims));
    assert.ok(Array.isArray(lead.source_conflicts));
  }
});

test("scored fixtures match score breakdown totals", () => {
  for (const lead of leads) {
    if (lead.priority_score === null) continue;
    const total = Object.values(lead.score_breakdown).reduce((sum, value) => sum + value, 0);
    assert.equal(lead.priority_score, total, lead.lead_id);
  }
});

test("evidence objects carry source and freshness metadata", () => {
  const allEvidence = leads.flatMap((lead) => [
    ...lead.crm_context.evidence,
    ...lead.enrichment_fields.evidence,
    ...lead.intent_signals.evidence,
    ...lead.public_signals.flatMap((signal) => signal.evidence)
  ]);

  assert.ok(allEvidence.length > 0);
  for (const item of allEvidence) {
    assert.ok(item.source_name);
    assert.ok(item.source_type);
    assert.ok(item.retrieved_at);
    assert.ok(item.source_updated_at || item.source_published_at);
    assert.ok(item.confidence);
    assert.equal(typeof item.eligible_for_crm_writeback, "boolean");
  }
});

test("public signals use publication metadata", () => {
  const publicEvidence = leads.flatMap((lead) => lead.public_signals.flatMap((signal) => signal.evidence));
  assert.ok(publicEvidence.length > 0);
  for (const item of publicEvidence) {
    assert.equal(item.source_type, "public_signal");
    assert.ok(item.source_published_at);
    assert.equal(item.source_updated_at, undefined);
  }
});

test("allowed claims exclude unsupported inference text", () => {
  for (const lead of leads) {
    const allowedText = lead.allowed_claims.map((claim) => claim.text).join(" ");
    assert.doesNotMatch(allowedText, /likely|ready to buy|investing in sales automation/i);
  }
});

test("OpenRouter prompt only includes allowed claims", async () => {
  const originalFetch = globalThis.fetch;
  let prompt = "";
  globalThis.fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body));
    prompt = body.messages[1].content;
    return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), { status: 200 });
  };

  try {
    await explainLeadWithOpenRouter(leads[0], { apiKey: "test", model: "test" });
    const payload = JSON.parse(prompt);
    assert.deepEqual(Object.keys(payload).sort(), [
      "allowed_claims",
      "band",
      "confidence",
      "score",
      "score_breakdown",
      "score_version"
    ]);
    assert.deepEqual(payload.allowed_claims, leads[0].allowed_claims);
    assert.equal("disallowed_claims" in payload, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("golden fixture grounds its score drivers", () => {
  const lead = leads.find((item) => item.lead_id === "golden-normal");
  assert.ok(lead);
  const allowedText = lead.allowed_claims.map((claim) => claim.text).join(" ");
  assert.match(allowedText, /500 employees/i);
  assert.match(allowedText, /demo request and pricing-page visit/i);
  assert.match(allowedText, /Series B funding round on July 1, 2026/i);
  assert.equal(groundedHook(lead), lead.hook);
  assert.equal(lead.public_signals[0].days_ago, 8);
  assert.equal(lead.public_signals[0].evidence[0].source_published_at, "2026-07-01T09:00:00.000Z");
});

test("fixtures mark unavailable data as missing", () => {
  const lead = leads.find((item) => item.lead_id === "small-high-intent");
  assert.ok(lead);
  assert.equal(lead.enrichment_fields.revenue_band, "Data unavailable");
  assert.ok(lead.missing_fields.includes("revenue_band"));
  const allowedText = lead.allowed_claims.map((claim) => claim.text).join(" ");
  assert.match(allowedText, /12 employees/i);
  assert.match(allowedText, /category surge/i);
  assert.equal(lead.score_breakdown.engagement_quality, 0);
});

test("source conflict fixture requires manual review", () => {
  const lead = leads.find((item) => item.lead_id === "stale-writeback");
  assert.ok(lead);
  assert.ok(lead.source_conflicts.length > 0);
  assert.equal(lead.priority_band, "Needs Manual Review");
  assert.equal(isWritebackEligible(lead), false);
  const allowedText = lead.allowed_claims.map((claim) => claim.text).join(" ");
  assert.match(allowedText, /300 employees/i);
  assert.match(allowedText, /75 employees/i);
  assert.match(allowedText, /420 days old/i);
});

test("no-public-signal fixture matches demo-request eval case", () => {
  const lead = leads.find((item) => item.lead_id === "no-public-signal");
  assert.ok(lead);
  assert.equal(lead.intent_signals.demo_request, true);
  assert.match(String(lead.intent_signals.evidence[0].field_value), /Demo request/i);
  const allowedText = lead.allowed_claims.map((claim) => claim.text).join(" ");
  assert.match(allowedText, /900 employees/i);
  assert.match(allowedText, /demo request/i);
  assert.equal(groundedHook(lead), "No grounded hook available - no recent verified signal found.");
});

test("fixtures expose allowed claims for missing data and weak opens", () => {
  const noData = leads.find((item) => item.lead_id === "no-usable-data");
  assert.ok(noData);
  const noDataClaims = noData.allowed_claims.map((claim) => claim.text).join(" ");
  assert.match(noDataClaims, /employees, revenue band, and intent signals/i);
  assert.doesNotMatch(noDataClaims, /required.*public signals/i);

  const weakOpens = leads.find((item) => item.lead_id === "weak-opens");
  assert.ok(weakOpens);
  const weakOpenClaims = weakOpens.allowed_claims.map((claim) => claim.text).join(" ");
  assert.match(weakOpenClaims, /420 employees/i);
  assert.match(weakOpenClaims, /5 email opens/i);
});

test("integration config requires secrets without hard-coding them", () => {
  assert.throws(() => openRouterConfigFromEnv({}), /OPENROUTER_API_KEY/);
  assert.throws(() => hubSpotConfigFromEnv({}), /HUBSPOT_ACCESS_TOKEN/);
  assert.equal(openRouterConfigFromEnv({ OPENROUTER_API_KEY: "test" }).model, "openai/gpt-4.1-mini");
});

test("HubSpot first call lists contacts instead of requiring a contact id", async () => {
  const originalFetch = globalThis.fetch;
  let requested = "";
  globalThis.fetch = async (input) => {
    requested = String(input);
    return new Response(JSON.stringify({ results: [] }), { status: 200 });
  };

  try {
    await listHubSpotContacts(1, { accessToken: "test" });
    assert.match(requested, /\/crm\/v3\/objects\/contacts\?/);
    assert.match(requested, /limit=1/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
