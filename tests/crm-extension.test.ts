import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { defaultConfigVersion } from "../src/lib/config.ts";
import { crmCardView, handleCrmExtensionRequest } from "../src/lib/crm-extension.ts";
import { leads } from "../src/data/leads.ts";
import { hubSpotRequiredScopes } from "../src/lib/integrations.ts";
import { RuntimeStore } from "../src/lib/persistence.ts";
import { verifyHubSpotRequestSignature } from "../src/lib/security.ts";

const secret = "hubspot-client-secret";
const baseUrl = "https://contextai.example.com";
const admin = { requestId: "setup", tenantId: "tenant-17", actorId: "admin", role: "revops_admin" as const };
const setup = () => {
  const store = new RuntimeStore(":memory:");
  store.saveTenant(admin.tenantId, "Issue 17 tenant");
  store.saveConfigVersion(admin, defaultConfigVersion);
  store.saveIntegration(admin, { integrationId: "hubspot-17", provider: "hubspot", externalAccountId: "1700", status: "disabled" });
  store.activateHubSpotIntegration(admin, "hubspot-17", {
    accessToken: "access", refreshToken: "refresh", scopes: [...hubSpotRequiredScopes],
    expiresAt: "2027-07-12T00:00:00.000Z", externalAccountId: "1700",
  }, Buffer.alloc(32, 17));
  return store;
};
const signed = (body: unknown, timestamp = String(Date.now())) => {
  const url = "/hubspot/crm-card?portalId=1700&userId=rep-17&appId=17";
  const raw = JSON.stringify(body);
  const signature = createHmac("sha256", secret).update(`POST${baseUrl}${url}${raw}${timestamp}`).digest("base64");
  return { method: "POST", url, body: raw, headers: { "x-hubspot-signature-v3": signature, "x-hubspot-request-timestamp": timestamp } };
};

test("CRM card uses narrow-safe native controls and clears stale record state", () => {
  const card = readFileSync(new URL("../hubspot/src/app/cards/ContextAICard.tsx", import.meta.url), "utf8");
  assert.match(card, /<ToggleGroup[\s\S]*toggleType="radioButtonList"/);
  assert.match(card, /<DescriptionList direction="column">/);
  assert.match(card, /<LoadingButton/);
  assert.match(card, /let active = true;[\s\S]*setData\(null\);[\s\S]*return \(\) => \{ active = false; \};/);
  assert.match(card, /recordGeneration[\s\S]*recordGeneration\.current\.value === generation/);
});

test("HubSpot v3 signatures reject tampering and stale requests", () => {
  const request = signed({ operation: "view", objectId: "golden-normal", objectTypeId: "0-1" });
  assert.equal(verifyHubSpotRequestSignature({ ...request, uri: `${baseUrl}${request.url}`, signature: request.headers["x-hubspot-signature-v3"], timestamp: request.headers["x-hubspot-request-timestamp"], clientSecret: secret }), true);
  assert.equal(verifyHubSpotRequestSignature({ ...request, uri: `${baseUrl}${request.url}`, body: `${request.body}x`, signature: request.headers["x-hubspot-signature-v3"], timestamp: request.headers["x-hubspot-request-timestamp"], clientSecret: secret }), false);
  const stale = signed({}, String(Date.now() - 300_001));
  assert.equal(verifyHubSpotRequestSignature({ ...stale, uri: `${baseUrl}${stale.url}`, signature: stale.headers["x-hubspot-signature-v3"], timestamp: stale.headers["x-hubspot-request-timestamp"], clientSecret: secret }), false);
});

test("CRM card enforces portal, assigned user, and contact or company context", () => {
  const store = setup();
  const packet = structuredClone(leads[0]!);
  store.saveEvaluation({ tenantId: admin.tenantId, idempotencyKey: "card-golden", packet, assignedRepId: "rep-17" });
  const env = { CONTEXTAI_API_URL: baseUrl, HUBSPOT_CLIENT_SECRET: secret };

  const startedAt = performance.now();
  const contact = handleCrmExtensionRequest(signed({ operation: "view", objectId: packet.lead_id, objectTypeId: "0-1" }), store, env);
  assert.equal(contact.status, 200);
  assert.ok(performance.now() - startedAt < 2_500);
  assert.equal((contact.body as { score: number }).score, packet.priority_score);
  assert.doesNotMatch(JSON.stringify(contact.body), new RegExp(packet.lead_identity.email, "i"));

  const company = handleCrmExtensionRequest(signed({ operation: "view", objectId: packet.account_id, objectTypeId: "0-2" }), store, env);
  assert.equal(company.status, 200);

  const wrongUserRequest = signed({ operation: "view", objectId: packet.lead_id, objectTypeId: "0-1" });
  const wrongUserUrl = wrongUserRequest.url.replace("rep-17", "rep-other");
  const wrongUserSignature = createHmac("sha256", secret).update(`POST${baseUrl}${wrongUserUrl}${wrongUserRequest.body}${wrongUserRequest.headers["x-hubspot-request-timestamp"]}`).digest("base64");
  assert.equal(handleCrmExtensionRequest({ ...wrongUserRequest, url: wrongUserUrl, headers: { ...wrongUserRequest.headers, "x-hubspot-signature-v3": wrongUserSignature } }, store, env).status, 404);
  assert.equal(handleCrmExtensionRequest({ ...signed({ operation: "view", objectId: packet.lead_id, objectTypeId: "0-1" }), headers: {} }, store, env).status, 401);
  const otherPortal = signed({ operation: "view", objectId: packet.lead_id, objectTypeId: "0-1" });
  const otherUrl = otherPortal.url.replace("portalId=1700", "portalId=9999");
  const otherSignature = createHmac("sha256", secret).update(`POST${baseUrl}${otherUrl}${otherPortal.body}${otherPortal.headers["x-hubspot-request-timestamp"]}`).digest("base64");
  assert.equal(handleCrmExtensionRequest({ ...otherPortal, url: otherUrl, headers: { ...otherPortal.headers, "x-hubspot-signature-v3": otherSignature } }, store, env).status, 403);
  store.close();
});

test("CRM card keeps fallback, stale, manual-review, and action telemetry usable", () => {
  const store = setup();
  const packet = structuredClone(leads.find(({ lead_id }) => lead_id === "no-usable-data")!);
  const stalePacket = structuredClone(leads.find(({ lead_id }) => lead_id === "stale-writeback")!);
  store.saveEvaluation({ tenantId: admin.tenantId, idempotencyKey: "card-fallback", packet, assignedRepId: "rep-17" });
  store.saveEvaluation({ tenantId: admin.tenantId, idempotencyKey: "card-stale", packet: stalePacket, assignedRepId: "rep-17" });
  const env = { CONTEXTAI_API_URL: baseUrl, HUBSPOT_CLIENT_SECRET: secret };
  const view = handleCrmExtensionRequest(signed({ operation: "view", objectId: packet.lead_id, objectTypeId: "0-1" }), store, env);
  assert.equal(view.status, 200);
  assert.equal((view.body as ReturnType<typeof crmCardView>).band, "Needs Manual Review");
  assert.ok((view.body as ReturnType<typeof crmCardView>).dataQuality.failedSources.length > 0);
  const staleView = handleCrmExtensionRequest(signed({ operation: "view", objectId: stalePacket.lead_id, objectTypeId: "0-1" }), store, env);
  assert.equal(staleView.status, 200);
  assert.ok((staleView.body as ReturnType<typeof crmCardView>).dataQuality.stale.length > 0);

  const outcome = handleCrmExtensionRequest(signed({ operation: "outcome", objectId: packet.lead_id, objectTypeId: "0-1", disposition: "overridden", actionType: "call" }), store, env);
  assert.equal(outcome.status, 202);
  const events = store.database.prepare("SELECT event_type FROM events ORDER BY event_type").all() as Array<{ event_type: string }>;
  assert.deepEqual(events.map(({ event_type }) => event_type), ["action.first_meaningful", "lead.viewed", "lead.viewed", "recommendation.disposition", "score.shown", "score.shown"]);
  store.close();
});
