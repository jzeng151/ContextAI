import assert from "node:assert/strict";
import test from "node:test";
import { leads } from "../src/data/leads.ts";
import { groundedHook, hasOnlyWeakOpenIntent, isWritebackEligible } from "../src/lib/contextai.ts";

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
