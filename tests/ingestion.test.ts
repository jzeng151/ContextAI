import assert from "node:assert/strict";
import test from "node:test";
import {
  enrichProfile,
  fetchIntentTriggers,
  fetchPublicSignals,
  writeCrmEnrichment,
} from "../src/lib/ingestion.ts";
import { buildLeadPacketFromSources } from "../src/lib/leadPipeline.ts";
import { assertLeadPacket } from "../src/lib/contextai.ts";

const evaluatedAt = "2026-07-09T09:00:00.000Z";

test("enrich_profile returns firmographics with freshness timestamp", async () => {
  const result = await enrichProfile("enterprisecorp.com", { evaluatedAt });
  assert.equal(result.status, "success");
  assert.equal(result.employees, 500);
  assert.equal(result.revenue_band, "$50M-$100M");
  assert.deepEqual(result.tech_stack, ["Salesforce"]);
  assert.ok(result.last_updated);
  assert.equal(result.confidence, "High");
  assert.equal(result.source_name, "Clearbit");
});

test("enrich_profile unavailable for unknown or error domains", async () => {
  const missing = await enrichProfile("test-error.com", { evaluatedAt });
  assert.equal(missing.status, "unavailable");
  assert.equal(missing.message, "Data unavailable");
  assert.equal(missing.employees, undefined);
});

test("fetch_intent_triggers returns demo and pricing signals", async () => {
  const result = await fetchIntentTriggers("john.smith@enterprisecorp.com", { evaluatedAt });
  assert.equal(result.status, "success");
  assert.equal(result.demo_request, true);
  assert.equal(result.pricing_page_visit, true);
  assert.ok(result.last_updated);
  assert.equal(result.confidence, "High");
});

test("fetch_intent_triggers unavailable without catalog match", async () => {
  const result = await fetchIntentTriggers("unknown@nowhere.example", { evaluatedAt });
  assert.equal(result.status, "unavailable");
  assert.equal(result.message, "Data unavailable");
});

test("fetch_public_signals returns funding with published_at", async () => {
  const result = await fetchPublicSignals("EnterpriseCorp", { evaluatedAt });
  assert.equal(result.status, "success");
  assert.equal(result.signals.length, 1);
  assert.equal(result.signals[0].label, "Series B funding announced");
  assert.ok(result.signals[0].published_at);
  assert.ok(result.signals[0].source_url.startsWith("http"));
});

test("fetch_public_signals unavailable when no hits", async () => {
  const result = await fetchPublicSignals("LeanTech", { evaluatedAt });
  assert.equal(result.status, "unavailable");
  assert.equal(result.signals.length, 0);
});

test("write_crm_enrichment is read-only and never writes", async () => {
  const originalFetch = globalThis.fetch;
  let called = false;
  globalThis.fetch = async () => {
    called = true;
    return new Response("{}", { status: 500 });
  };
  try {
    const result = await writeCrmEnrichment("golden-normal", { numberofemployees: "500" });
    assert.equal(result.status, "skipped");
    assert.equal(result.writable, false);
    assert.match(result.reason, /no hubspot write/i);
    assert.equal(called, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("pipeline scores golden seed after tool ingestion", async () => {
  const { lead, tools } = await buildLeadPacketFromSources({
    lead_id: "pipeline-golden",
    account_id: "acct-enterprisecorp",
    name: "John Smith",
    title: "Director of IT",
    company: "EnterpriseCorp",
    email: "john.smith@enterprisecorp.com",
    domain: "enterprisecorp.com",
    owner: "Maya Chen",
    source: "Inbound demo",
    stage: "Open",
    evaluation_timestamp: evaluatedAt,
  });

  assert.doesNotThrow(() => assertLeadPacket(lead));
  assert.equal(tools.enrich_profile, "success");
  assert.equal(tools.fetch_intent_triggers, "success");
  assert.equal(tools.fetch_public_signals, "success");
  assert.equal(tools.write_crm_enrichment, "skipped");
  assert.equal(lead.priority_score, 94);
  assert.equal(lead.priority_band, "Hot");
  assert.equal(lead.enrichment_fields.last_updated_days_ago, 18);
  assert.equal(lead.enrichment_fields.evidence[0]?.confidence, "High");
  assert.equal(lead.score_breakdown.data_confidence, 5);
});

test("pipeline null-score fallback when enrichment and intent unavailable", async () => {
  const { lead, tools } = await buildLeadPacketFromSources({
    lead_id: "pipeline-empty",
    account_id: "acct-test-error",
    name: "Unknown User",
    title: "Data unavailable",
    company: "test-error.com",
    email: "unknown@test-error.com",
    domain: "test-error.com",
    owner: "Maya Chen",
    source: "Reassigned lead",
    stage: "Needs research",
    evaluation_timestamp: evaluatedAt,
  });

  assert.doesNotThrow(() => assertLeadPacket(lead));
  assert.equal(tools.enrich_profile, "unavailable");
  assert.equal(tools.fetch_intent_triggers, "unavailable");
  assert.equal(lead.priority_score, null);
  assert.equal(lead.priority_band, "Needs Manual Review");
  assert.equal(lead.score_breakdown.data_confidence, 0);
});

test("live API URL path maps payload into enrichment freshness", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        employees: 250,
        revenue_band: "$10M-$25M",
        tech_stack: ["HubSpot"],
        last_updated: "2026-06-09T09:00:00.000Z",
        confidence: "High",
        source_name: "LiveEnrich",
      }),
      { status: 200 }
    );

  try {
    const result = await enrichProfile("anycorp.com", {
      evaluatedAt,
      env: { ENRICHMENT_API_URL: "https://enrich.example/v1/profile" },
    });
    assert.equal(result.status, "success");
    assert.equal(result.employees, 250);
    assert.equal(result.last_updated, "2026-06-09T09:00:00.000Z");
    assert.equal(result.source_name, "LiveEnrich");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("API timeout returns Data unavailable without inventing fields", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    const error = new Error("The operation was aborted due to timeout");
    error.name = "TimeoutError";
    throw error;
  };

  try {
    const result = await enrichProfile("anycorp.com", {
      evaluatedAt,
      env: { ENRICHMENT_API_URL: "https://enrich.example/v1/profile" },
    });
    assert.equal(result.status, "timeout");
    assert.equal(result.message, "Data unavailable");
    assert.equal(result.employees, undefined);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
