import assert from "node:assert/strict";
import test from "node:test";
import { leads } from "../src/data/leads.ts";
import { groundedHook, hasOnlyWeakOpenIntent, isWritebackEligible } from "../src/lib/contextai.ts";
import { hubSpotConfigFromEnv, listHubSpotContacts, openRouterConfigFromEnv } from "../src/lib/integrations.ts";

test("stale enrichment is not eligible for CRM writeback", () => {
  const lead = leads.find((item) => item.id === "stale-writeback");
  assert.ok(lead);
  assert.equal(isWritebackEligible(lead), false);
});

test("email opens alone stay weak", () => {
  const lead = leads.find((item) => item.id === "weak-opens");
  assert.ok(lead);
  assert.equal(hasOnlyWeakOpenIntent(lead), true);
  assert.match(lead.reason, /opens alone are not reliable buying intent/i);
});

test("missing public signal uses grounded hook fallback", () => {
  const lead = leads.find((item) => item.id === "no-public-signal");
  assert.ok(lead);
  assert.equal(groundedHook(lead), "No grounded hook available - no recent verified signal found.");
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
