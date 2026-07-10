import assert from "node:assert/strict";
import test from "node:test";
import { leads } from "../src/data/leads.ts";
import { hasOnlyWeakOpenIntent } from "../src/lib/contextai.ts";
import {
  applyDeterministicScore,
  BAND_THRESHOLDS,
  SCORE_CAPS,
  SCORE_VERSION,
  requiresManualReview,
  scoreLead,
} from "../src/lib/scoring.ts";

const byId = (id: string) => {
  const lead = leads.find((item) => item.lead_id === id);
  assert.ok(lead, id);
  return lead;
};

test("score version is stamped on every evaluation", () => {
  for (const lead of leads) {
    assert.equal(scoreLead(lead).score_version, SCORE_VERSION);
    assert.equal(lead.score_version, SCORE_VERSION);
  }
});

test("default caps match PRD weights", () => {
  assert.deepEqual(SCORE_CAPS, {
    icp_fit: 30,
    high_intent_actions: 25,
    engagement_quality: 15,
    public_timing_signals: 15,
    crm_process_context: 10,
    data_confidence: 5,
  });
});

test("golden normal scores Hot with ICP + intent + public timing", () => {
  const lead = byId("golden-normal");
  const scored = scoreLead(lead);
  assert.equal(scored.priority_score, 94);
  assert.equal(scored.priority_band, "Hot");
  assert.equal(scored.confidence, "High");
  assert.deepEqual(scored.score_breakdown, {
    icp_fit: 30,
    high_intent_actions: 25,
    engagement_quality: 14,
    public_timing_signals: 15,
    crm_process_context: 5,
    data_confidence: 5,
  });
});

test("small company with surge stays below Hot", () => {
  const lead = byId("small-high-intent");
  const scored = scoreLead(lead);
  assert.equal(scored.priority_score, 50);
  assert.equal(scored.priority_band, "Cold");
  assert.equal(scored.confidence, "Medium");
  assert.ok(scored.priority_score! < BAND_THRESHOLDS.hot);
});

test("email opens alone cannot produce Hot", () => {
  const lead = byId("weak-opens");
  assert.equal(hasOnlyWeakOpenIntent(lead), true);
  const scored = scoreLead(lead);
  assert.notEqual(scored.priority_band, "Hot");
  assert.ok((scored.priority_score ?? 0) < BAND_THRESHOLDS.hot);
  assert.equal(scored.score_breakdown.high_intent_actions, 0);
  assert.ok(scored.score_breakdown.engagement_quality <= 10);
});

test("missing firmographics and intent require manual review", () => {
  const lead = byId("no-usable-data");
  assert.equal(requiresManualReview(lead), true);
  const scored = scoreLead(lead);
  assert.equal(scored.priority_score, null);
  assert.equal(scored.priority_band, "Needs Manual Review");
  assert.equal(scored.confidence, "Low");
});

test("source conflicts require manual review", () => {
  const lead = byId("stale-writeback");
  assert.equal(requiresManualReview(lead), true);
  const scored = scoreLead(lead);
  assert.equal(scored.priority_score, null);
  assert.equal(scored.priority_band, "Needs Manual Review");
  assert.equal(scored.confidence, "Low");
});

test("no-public-signal demo request still scores Hot from fit + intent", () => {
  const lead = byId("no-public-signal");
  const scored = scoreLead(lead);
  assert.equal(scored.priority_score, 83);
  assert.equal(scored.priority_band, "Hot");
  assert.equal(scored.score_breakdown.public_timing_signals, 0);
});

test("applyDeterministicScore is idempotent for score fields", () => {
  const lead = byId("golden-normal");
  const once = applyDeterministicScore(lead);
  const twice = applyDeterministicScore(once);
  assert.deepEqual(twice.score_breakdown, once.score_breakdown);
  assert.equal(twice.priority_score, once.priority_score);
  assert.equal(twice.priority_band, once.priority_band);
});

test("band thresholds: Hot >= 80, Warm >= 60, else Cold", () => {
  assert.equal(BAND_THRESHOLDS.hot, 80);
  assert.equal(BAND_THRESHOLDS.warm, 60);
  for (const lead of leads) {
    if (lead.priority_score === null) {
      assert.equal(lead.priority_band, "Needs Manual Review");
      continue;
    }
    const expected =
      lead.priority_score >= 80 ? "Hot" : lead.priority_score >= 60 ? "Warm" : "Cold";
    assert.equal(lead.priority_band, expected, lead.lead_id);
  }
});
