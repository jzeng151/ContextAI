import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { leads } from "../src/data/leads.ts";
import {
  dashboardOutcomeEvents,
  hubSpotDashboardPackets,
  dashboardPromptVersion,
  dashboardViewEvents
} from "../src/lib/dashboard.ts";
import { defaultConfigVersion } from "../src/lib/config.ts";
import { assertPilotEvent } from "../src/lib/instrumentation.ts";
import { RuntimeStore } from "../src/lib/persistence.ts";

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
  const ignoredWithAction = dashboardOutcomeEvents({
    ...input,
    disposition: "ignored",
    actionType: "nurture",
    idempotencySeed: "dashboard:eval-3"
  });
  assert.deepEqual(ignoredWithAction.map(({ name }) => name), [
    "recommendation.disposition",
    "action.first_meaningful"
  ]);
  assert.deepEqual(ignoredWithAction.map(({ data }) => data), [
    { disposition: "ignored", actionType: "nurture" },
    { actionType: "nurture" }
  ]);
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

test("live dashboard excludes evaluations that are not current HubSpot contacts", () => {
  const store = new RuntimeStore(":memory:");
  const identity = { requestId: "dashboard-live", tenantId: "tenant-live", actorId: "admin", role: "revops_admin" as const };
  store.saveTenant(identity.tenantId, "Live dashboard");
  store.saveConfigVersion(identity, defaultConfigVersion);
  const current = structuredClone(leads[0]!);
  current.lead_id = "hubspot-contact-1";
  current.evaluation_id = "hubspot-evaluation-1";
  const fixtureOnly = structuredClone(leads[1]!);
  fixtureOnly.evaluation_id = "fixture-evaluation";
  store.saveEvaluation({ tenantId: identity.tenantId, idempotencyKey: "current", packet: current });
  store.saveEvaluation({ tenantId: identity.tenantId, idempotencyKey: "fixture", packet: fixtureOnly });

  assert.deepEqual(hubSpotDashboardPackets(store, identity, ["hubspot-contact-1"]).map(({ lead_id }) => lead_id), ["hubspot-contact-1"]);
  store.close();
});

test("dashboard runtime keeps refresh secure, bounded, auditable, and current", () => {
  const server = readFileSync(new URL("../src/server.ts", import.meta.url), "utf8");
  const page = readFileSync(new URL("../src/pages/index.astro", import.meta.url), "utf8");
  assert.match(server, /isLoopbackAddress\(request\.socket\.remoteAddress\)/);
  assert.match(server, /adminOrigins\.has\(request\.headers\.origin\)/);
  assert.match(server, /index \+= 4/);
  assert.match(server, /evaluateLead\(\{\s*identity,/);
  assert.match(server, /result\.value\.packet/);
  assert.match(page, /fetchDashboard\("\/dashboard"\)/);
  assert.match(page, /renderClientLeads/);
  assert.doesNotMatch(page, /location\.reload\(\)/);
});
