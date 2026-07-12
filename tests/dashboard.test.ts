import assert from "node:assert/strict";
import test from "node:test";
import { leads } from "../src/data/leads.ts";
import {
  dashboardOutcomeEvents,
  dashboardPromptVersion,
  dashboardViewEvents
} from "../src/lib/dashboard.ts";
import { assertPilotEvent } from "../src/lib/instrumentation.ts";

test("dashboard outcomes emit contract-safe disposition and optional action events", () => {
  const packet = leads[0]!;
  const snapshot = structuredClone(packet);
  const input = {
    packet,
    tenantId: "workspace-1",
    actorType: "rep" as const,
    actorId: "rep-1",
    configVersion: "config-v1",
    occurredAt: "2026-07-11T14:00:00.000Z",
    idempotencySeed: "dashboard:eval-1"
  };
  const events = dashboardOutcomeEvents({
    ...input,
    disposition: "accepted",
    actionType: "email"
  });

  assert.deepEqual(events.map(({ name }) => name), [
    "recommendation.disposition",
    "action.first_meaningful"
  ]);
  events.forEach(assertPilotEvent);
  assert.deepEqual(events.map(({ idempotencyKey }) => idempotencyKey), [
    "dashboard:eval-1:recommendation.disposition",
    "dashboard:eval-1:action.first_meaningful"
  ]);
  assert.ok(events.every(({ configVersion }) => configVersion === "config-v1"));
  assert.ok(events.every(({ promptVersion }) => promptVersion === dashboardPromptVersion));
  assert.ok(!JSON.stringify(events).includes(packet.lead_identity.email));
  assert.deepEqual(packet, snapshot);

  const ignored = dashboardOutcomeEvents({
    ...input,
    disposition: "ignored",
    idempotencySeed: "dashboard:eval-2"
  });
  assert.equal(ignored.length, 1);
  assert.deepEqual(ignored[0]!.data, { disposition: "ignored" });
  assert.throws(
    () => dashboardOutcomeEvents({ ...input, disposition: "ignored", actorId: packet.lead_identity.email }),
    /excluded PII/i
  );
});

test("dashboard views emit one idempotent view and score event from a minimal packet", () => {
  const lead = leads[0]!;
  const packet = {
    request_id: lead.request_id,
    evaluation_id: lead.evaluation_id,
    lead_id: lead.lead_id,
    account_id: lead.account_id,
    score_version: lead.score_version,
    priority_score: lead.priority_score,
    priority_band: lead.priority_band
  };
  const input = {
    packet,
    tenantId: "workspace-1",
    actorType: "rep" as const,
    actorId: "rep-1",
    configVersion: "config-v1",
    occurredAt: "2026-07-11T14:00:00.000Z",
    idempotencySeed: "dashboard:view:eval-1"
  };
  const events = dashboardViewEvents(input);

  assert.deepEqual(events.map(({ name }) => name), ["lead.viewed", "score.shown"]);
  assert.deepEqual(events.map(({ idempotencyKey }) => idempotencyKey), [
    "dashboard:view:eval-1:lead.viewed",
    "dashboard:view:eval-1:score.shown"
  ]);
  assert.deepEqual(events.map(({ data }) => data), [
    { surface: "dashboard" },
    { priorityScore: lead.priority_score, priorityBand: lead.priority_band, surface: "dashboard" }
  ]);
  assert.ok(events.every(({ configVersion }) => configVersion === "config-v1"));
  assert.ok(events.every(({ promptVersion }) => promptVersion === dashboardPromptVersion));
  events.forEach(assertPilotEvent);
  assert.deepEqual(dashboardViewEvents(input), events);
  assert.ok(!JSON.stringify(events).includes(lead.lead_identity.email));
});
