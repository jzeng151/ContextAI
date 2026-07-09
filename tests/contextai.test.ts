import assert from "node:assert/strict";
import test from "node:test";
import { leads } from "../src/data/leads.ts";
import { assertLeadPacket, groundedHook, hasOnlyWeakOpenIntent, isWritebackEligible } from "../src/lib/contextai.ts";
import { explainLeadWithOpenRouter, hubSpotConfigFromEnv, listHubSpotContacts, openRouterConfigFromEnv, writeHubSpotEnrichment } from "../src/lib/integrations.ts";

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
  assert.equal(groundedHook({ ...lead, hook: "Reference OtherCorp's Series B funding announced on July 1, 2026." }), "No grounded hook available - no recent verified signal found.");
  assert.equal(groundedHook({ ...lead, allowed_claims: [] }), "No grounded hook available - no recent verified signal found.");
  assert.equal(groundedHook({ ...lead, allowed_claims: [{ text: "EnterpriseCorp announced layoffs.", evidence_source: "Crunchbase" }] }), "No grounded hook available - no recent verified signal found.");
  assert.equal(groundedHook({ ...lead, lead_identity: { ...lead.lead_identity, company: "Corp" } }), "No grounded hook available - no recent verified signal found.");
  assert.equal(groundedHook({ ...lead, allowed_claims: [{ ...lead.allowed_claims[2], evidence_source: "Not Crunchbase" }] }), "No grounded hook available - no recent verified signal found.");
  assert.equal(groundedHook({ ...lead, allowed_claims: [{ ...lead.allowed_claims[2], text: lead.allowed_claims[2].text.replace("July 1", "July 8") }] }), "No grounded hook available - no recent verified signal found.");
});

test("short public signal labels can ground hooks", () => {
  const lead = leads.find((item) => item.lead_id === "golden-normal");
  assert.ok(lead);
  const evidence = { ...lead.public_signals[0].evidence[0], field_value: "AI" };
  const publicSignal = { ...lead.public_signals[0], label: "AI", evidence: [evidence] };
  const hook = "Reference EnterpriseCorp's AI announcement.";

  assert.equal(groundedHook({
    ...lead,
    hook,
    public_signals: [publicSignal],
    allowed_claims: [{ text: "EnterpriseCorp announced an AI initiative.", evidence_source: evidence.source_name }]
  }), hook);
  assert.equal(groundedHook({
    ...lead,
    hook,
    public_signals: [publicSignal],
    allowed_claims: [{ text: "EnterpriseCorp said results improved.", evidence_source: evidence.source_name }]
  }), "No grounded hook available - no recent verified signal found.");
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

test("writeback eligibility allows safe fields alongside non-writable evidence", () => {
  const lead = leads.find((item) => item.lead_id === "no-public-signal");
  assert.ok(lead);
  assert.equal(isWritebackEligible({
    ...lead,
    enrichment_fields: {
      ...lead.enrichment_fields,
      last_updated_days_ago: 31,
      evidence: [
        ...lead.enrichment_fields.evidence,
        {
          ...lead.enrichment_fields.evidence[0],
          field_name: undefined,
          field_value: ["UnverifiedTech"],
          confidence: "Low",
          eligible_for_crm_writeback: false,
          source_updated_at: "2025-05-15T09:00:00.000Z"
        }
      ]
    }
  }), true);
});

test("HubSpot writeback requires an eligible lead and allowlisted properties", async () => {
  const eligible = leads.find((item) => item.lead_id === "no-public-signal");
  const stale = leads.find((item) => item.lead_id === "stale-writeback");
  assert.ok(eligible && stale);
  const config = { accessToken: "test" };

  await assert.rejects(writeHubSpotEnrichment(stale, "1", { company: "SafeCo" }, ["company"], config), /not eligible/i);
  await assert.rejects(writeHubSpotEnrichment(eligible, "1", { hubspot_owner_id: "2" }, ["company"], config), /not allowlisted/i);
  await assert.rejects(writeHubSpotEnrichment(eligible, "1", { annualrevenue: "900" }, ["annualrevenue"], config), /lack eligible evidence/i);

  const originalFetch = globalThis.fetch;
  let body = "";
  globalThis.fetch = async (_input, init) => {
    body = String(init?.body);
    return new Response(JSON.stringify({ id: "1", properties: { numberofemployees: "900" } }), { status: 200 });
  };
  try {
    await writeHubSpotEnrichment(eligible, "1", { numberofemployees: "900" }, ["numberofemployees"], config);
    assert.deepEqual(JSON.parse(body), { properties: { numberofemployees: "900" } });
  } finally {
    globalThis.fetch = originalFetch;
  }
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

test("runtime contract validation rejects malformed evidence", () => {
  const lead = leads[0];
  assert.doesNotThrow(() => assertLeadPacket(lead));
  assert.throws(() => assertLeadPacket({
    ...lead,
    public_signals: [{
      ...lead.public_signals[0],
      evidence: [{ ...lead.public_signals[0].evidence[0], source_url: undefined }]
    }]
  }), /invalid lead packet contract/i);
  assert.throws(() => assertLeadPacket({
    ...lead,
    enrichment_fields: {
      ...lead.enrichment_fields,
      evidence: [{ ...lead.enrichment_fields.evidence[0], field_value: "" }]
    }
  }), /invalid lead packet contract/i);
});

test("runtime contract validation enforces score caps, totals, and bands", () => {
  const lead = leads[0];
  assert.throws(() => assertLeadPacket({ ...lead, priority_score: 95 }), /invalid lead packet contract/i);
  assert.throws(() => assertLeadPacket({ ...lead, priority_band: "Cold" }), /invalid lead packet contract/i);
  assert.throws(() => assertLeadPacket({
    ...lead,
    priority_score: 95,
    score_breakdown: { ...lead.score_breakdown, data_confidence: 6 }
  }), /invalid lead packet contract/i);
  assert.throws(() => assertLeadPacket({ ...lead, priority_score: 94, priority_band: "Needs Manual Review" }), /invalid lead packet contract/i);
  assert.throws(() => assertLeadPacket({
    ...lead,
    score_breakdown: { ...lead.score_breakdown, sensitive_affinity: 0 }
  }), /invalid lead packet contract/i);
});

test("runtime contract validation rejects invalid intent counters", () => {
  const lead = leads[0];
  for (const opens of [-1, 0.5, Infinity]) {
    assert.throws(() => assertLeadPacket({
      ...lead,
      intent_signals: { ...lead.intent_signals, opens }
    }), /invalid lead packet contract/i);
  }
});

test("runtime contract validation requires dated public-signal evidence", () => {
  const lead = leads[0];
  assert.throws(() => assertLeadPacket({
    ...lead,
    public_signals: [{ ...lead.public_signals[0], evidence: [] }]
  }), /invalid lead packet contract/i);
  for (const days_ago of [-1, Infinity, 7]) {
    assert.throws(() => assertLeadPacket({
      ...lead,
      public_signals: [{ ...lead.public_signals[0], days_ago }]
    }), /invalid lead packet contract/i);
  }
  assert.throws(() => assertLeadPacket({
    ...lead,
    enrichment_fields: { ...lead.enrichment_fields, last_updated_days_ago: -1 }
  }), /invalid lead packet contract/i);
});

test("runtime contract validation ties derived fields to evidence", () => {
  const lead = leads[0];
  const invalidPackets = [
    { ...lead, enrichment_fields: { ...lead.enrichment_fields, employees: -1 } },
    { ...lead, enrichment_fields: { ...lead.enrichment_fields, employees: 501 } },
    { ...lead, enrichment_fields: { ...lead.enrichment_fields, revenue_band: "$1B+" } },
    { ...lead, enrichment_fields: { ...lead.enrichment_fields, tech_stack: ["UnknownTech"] } },
    { ...lead, enrichment_fields: { ...lead.enrichment_fields, last_updated_days_ago: 1 } },
    { ...lead, intent_signals: { ...lead.intent_signals, opens: 3 } },
    { ...lead, intent_signals: { ...lead.intent_signals, surge: true } },
    { ...lead, public_signals: [{ ...lead.public_signals[0], label: "Acquisition announced" }] },
    { ...lead, public_signals: [{ ...lead.public_signals[0], source: "OtherSource" }] },
    { ...lead, public_signals: [{ ...lead.public_signals[0], evidence: [{ ...lead.public_signals[0].evidence[0], source_url: "not a url" }] }] },
    { ...lead, public_signals: [] }
  ];
  for (const packet of invalidPackets) {
    assert.throws(() => assertLeadPacket(packet), /invalid lead packet contract/i);
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
  let systemPrompt = "";
  globalThis.fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body));
    systemPrompt = body.messages[0].content;
    prompt = body.messages[1].content;
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ explanation: "Grounded.", claim_indexes: [0] }) } }] }), { status: 200 });
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
    assert.match(systemPrompt, /untrusted data/i);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("OpenRouter output requires valid allowed-claim citations", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    choices: [{ message: { content: JSON.stringify({ explanation: "Unsupported.", claim_indexes: [99] }) } }]
  }), { status: 200 });

  try {
    await assert.rejects(explainLeadWithOpenRouter(leads[0], { apiKey: "test", model: "test" }), /invalid grounded explanation/i);
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
  assert.equal(lead.enrichment_fields.revenue_band, undefined);
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
  assert.equal(lead.intent_signals.surge, false);
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
