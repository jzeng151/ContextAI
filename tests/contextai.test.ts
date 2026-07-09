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
    assert.deepEqual(payload.allowed_claims, leads[0].allowed_claims);
    assert.equal("disallowed_claims" in payload, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("source conflict fixture requires manual review", () => {
  const lead = leads.find((item) => item.lead_id === "stale-writeback");
  assert.ok(lead);
  assert.ok(lead.source_conflicts.length > 0);
  assert.equal(lead.priority_band, "Needs Manual Review");
  assert.equal(isWritebackEligible(lead), false);
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
