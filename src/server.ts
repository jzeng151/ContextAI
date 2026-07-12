import { createServer } from "node:http";
import { createConfigDraft, type ScoringConfig } from "./lib/config.ts";
import { getHubSpotLeadRecord, listAssignedOpenHubSpotLeads, writeHubSpotProperties } from "./lib/integrations.ts";
import { handleAssignmentEvent, parseHubSpotAssignmentEvents, runMorningEvaluation, verifyAssignmentSignature } from "./lib/orchestration.ts";
import { RuntimeStore } from "./lib/persistence.ts";
import { authenticateBearer, type RequestIdentity } from "./lib/security.ts";
import { secretKeyFromEnv } from "./lib/secrets.ts";
import { handleCrmExtensionRequest } from "./lib/crm-extension.ts";
import { hubSpotWritebackPolicy, hubSpotWritebackPolicyFor, rollbackLeadWriteback, rollbackWriteback } from "./lib/writeback.ts";

const store = new RuntimeStore();
const host = process.env.HOST ?? "127.0.0.1";
const port = Number(process.env.PORT ?? 4000);
const adminOrigin = process.env.CONTEXTAI_ADMIN_ORIGIN ?? "http://127.0.0.1:4321";
if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error("PORT must be an integer from 1 to 65535");

const json = (response: Parameters<Parameters<typeof createServer>[0]>[1], status: number, body: unknown) => {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
};
const body = async (request: Parameters<Parameters<typeof createServer>[0]>[0]) => {
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 1_000_000) throw new Error("Request body is too large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
};
const tenantId = process.env.CONTEXTAI_TENANT_ID ?? "local";
const adminIdentity = (request: Parameters<Parameters<typeof createServer>[0]>[0], response: Parameters<Parameters<typeof createServer>[0]>[1]) => {
  let identity: RequestIdentity;
  try {
    identity = authenticateBearer(request.headers.authorization);
  } catch {
    json(response, 401, { error: "Authentication required" });
    return null;
  }
  if (identity.tenantId !== tenantId || identity.role !== "revops_admin") {
    json(response, 403, { error: "RevOps Admin access required" });
    return null;
  }
  return identity;
};
const hubSpotConfigFor = async (identity: RequestIdentity) => {
  const integrationId = process.env.HUBSPOT_INTEGRATION_ID;
  if (!integrationId) throw new Error("HUBSPOT_INTEGRATION_ID is required");
  return { accessToken: await store.getHubSpotAccessToken(identity, integrationId, secretKeyFromEnv()) };
};
const hubSpotDependencies = (identity: RequestIdentity) => {
  return {
    getCrmLead: async (contactId: string) => getHubSpotLeadRecord(contactId, await hubSpotConfigFor(identity)),
    listAssignedOpen: async (ownerId: string) => listAssignedOpenHubSpotLeads(ownerId, await hubSpotConfigFor(identity)),
  };
};

const server = createServer(async (request, response) => {
  const origin = request.headers.origin;
  if (origin === adminOrigin) {
    response.setHeader("Access-Control-Allow-Origin", origin);
    response.setHeader("Vary", "Origin");
    response.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
    response.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  }
  if (request.method === "OPTIONS") {
    if (origin && origin !== adminOrigin) return json(response, 403, { error: "Origin not allowed" });
    response.writeHead(204).end();
    return;
  }
  const path = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`).pathname;
  if (request.method === "GET" && path === "/health") {
    json(response, 200, { status: "ok" });
    return;
  }
  try {
    if (request.method === "GET" && path === "/admin/config") {
      const identity = adminIdentity(request, response);
      if (!identity) return;
      return json(response, 200, { versions: store.listConfigVersions(identity) });
    }
    if (request.method === "POST" && path === "/admin/config/publish") {
      const identity = adminIdentity(request, response);
      if (!identity) return;
      const input = JSON.parse(await body(request)) as { draftId?: string; changeSummary?: string; adminNotes?: string; config?: ScoringConfig };
      if (!input.draftId?.trim() || !input.changeSummary?.trim() || !input.adminNotes?.trim() || !input.config) return json(response, 400, { error: "draftId, changeSummary, adminNotes, and config are required" });
      const existing = store.listConfigVersions(identity).find(({ id }) => id === input.draftId);
      if (existing) {
        if (existing.author !== identity.actorId || existing.changeSummary !== input.changeSummary || existing.adminNotes !== input.adminNotes || JSON.stringify(existing.config) !== JSON.stringify(input.config)) {
          throw new Error("Config draft ID already belongs to different content");
        }
      } else {
        store.saveConfigVersion(identity, createConfigDraft({ id: input.draftId, author: identity.actorId, createdAt: new Date().toISOString(), changeSummary: input.changeSummary, adminNotes: input.adminNotes, config: input.config }));
      }
      return json(response, 200, store.publishConfigDraft(identity, input.draftId));
    }
    if (request.method === "GET" && path === "/admin/reviews") {
      const identity = adminIdentity(request, response);
      if (!identity) return;
      const reviews = store.listReviewItems(identity).map((row: unknown) => {
        const item = row as Record<string, unknown> & { payload_json: string };
        const { payload_json, ...review } = item;
        const payload = JSON.parse(payload_json) as Record<string, any>;
        return { ...review, payload: { ...payload, leadName: payload.leadName ?? payload.lead_identity?.name, company: payload.company ?? payload.lead_identity?.company, leadId: payload.leadId ?? payload.lead_id } };
      });
      return json(response, 200, { reviews });
    }
    if (request.method === "GET" && path === "/admin/audits") {
      const identity = adminIdentity(request, response);
      if (!identity) return;
      return json(response, 200, { audits: store.listWritebackAudits(identity) });
    }
    if (request.method === "GET" && path === "/admin/integrations") {
      const identity = adminIdentity(request, response);
      if (!identity) return;
      return json(response, 200, { integrations: store.listIntegrationStatuses(identity) });
    }
    const reviewDecision = request.method === "POST" ? path.match(/^\/admin\/reviews\/([^/]+)\/decision$/) : null;
    if (reviewDecision) {
      const identity = adminIdentity(request, response);
      if (!identity) return;
      const input = JSON.parse(await body(request)) as { decision?: string; note?: string };
      if ((input.decision !== "resolved" && input.decision !== "dismissed") || !input.note?.trim()) return json(response, 400, { error: "decision and note are required" });
      return json(response, 200, store.decideReviewItem(identity, decodeURIComponent(reviewDecision[1]!), input.decision, input.note));
    }
    const fieldRollback = request.method === "POST" ? path.match(/^\/admin\/writebacks\/([^/]+)\/rollback$/) : null;
    const leadRollback = request.method === "POST" ? path.match(/^\/admin\/evaluations\/([^/]+)\/rollback$/) : null;
    if (fieldRollback || leadRollback) {
      const identity = adminIdentity(request, response);
      if (!identity) return;
      const audit = fieldRollback ? store.getAuditRecord(decodeURIComponent(fieldRollback[1]!)) : store.listWrittenAuditRecords(identity.tenantId, decodeURIComponent(leadRollback![1]!))[0];
      if (!audit || audit.tenant_id !== identity.tenantId) return json(response, 404, { error: "Rollback target not found" });
      if (audit.policy_version === "legacy") return json(response, 409, { error: "Legacy writes require manual reconciliation" });
      const provenance = store.getGovernanceAudit(identity, audit.evaluation_id);
      if (!provenance?.configVersion) throw new Error("Rollback configuration is unavailable");
      const basePolicy = audit.policy_version === hubSpotWritebackPolicy.version
        ? hubSpotWritebackPolicy
        : hubSpotWritebackPolicyFor(provenance.configVersion.config, provenance.configVersion.id);
      const policy = { ...basePolicy, liveWritesEnabled: true };
      const worker = { ...identity, actorId: "admin-rollback-worker", role: "system" as const };
      const config = await hubSpotConfigFor(worker);
      const options = { store, tenantId: identity.tenantId, actorType: identity.role, actorId: identity.actorId, identity, policy, authorizedLiveWrite: true as const, write: (input: Parameters<typeof writeHubSpotProperties>[0]) => writeHubSpotProperties(input, config) };
      const rolledBack = fieldRollback
        ? await rollbackWriteback([audit.audit_id], options)
        : await rollbackLeadWriteback(audit.evaluation_id, options);
      return json(response, 200, { rollbacks: rolledBack });
    }
    if (request.method === "POST" && request.url === "/webhooks/hubspot/assignments") {
      const raw = await body(request);
      if (!verifyAssignmentSignature(raw, request.headers["x-contextai-signature"] as string | undefined, process.env.HUBSPOT_WEBHOOK_SECRET ?? "")) return json(response, 401, { error: "Invalid webhook signature" });
      const events = parseHubSpotAssignmentEvents(JSON.parse(raw), tenantId);
      if (events.some((event) => event.tenantId !== tenantId)) return json(response, 403, { error: "Tenant does not match the configured integration" });
      const results = [];
      for (const event of events) {
        const identity = { requestId: event.eventId, tenantId, actorId: "hubspot-webhook", role: "integration" as const };
        results.push(await handleAssignmentEvent(event, { identity, store, dependencies: hubSpotDependencies(identity) }));
      }
      return json(response, 202, { evaluations: results.map((result) => ({ evaluationId: result.packet.evaluation_id, replayed: result.replayed })) });
    }
    if (request.method === "POST" && request.url === "/internal/morning-run") {
      const identity = authenticateBearer(request.headers.authorization);
      if (identity.tenantId !== tenantId || identity.role === "rep") return json(response, 403, { error: "Morning-run access denied" });
      const input = JSON.parse(await body(request)) as { ownerId?: string; scheduledFor?: string };
      if (!input.ownerId?.trim()) return json(response, 400, { error: "ownerId is required" });
      const tokenIdentity = { ...identity, actorId: "morning-runner", role: "system" as const };
      const dependencies = hubSpotDependencies(tokenIdentity);
      const results = await runMorningEvaluation({ identity, ownerId: input.ownerId, scheduledFor: input.scheduledFor ?? new Date().toISOString(), store, dependencies, listAssignedOpen: dependencies.listAssignedOpen });
      return json(response, 202, { results });
    }
    if (request.method === "POST" && request.url?.startsWith("/hubspot/crm-card?")) {
      const raw = await body(request);
      const result = handleCrmExtensionRequest({ method: request.method, url: request.url, headers: request.headers, body: raw }, store);
      return json(response, result.status, result.body);
    }
    response.writeHead(404).end();
  } catch (error) {
    json(response, 400, { error: error instanceof Error ? error.message : "Request failed" });
  }
});

server.listen(port, host, () => console.log(`ContextAI server listening on http://${host}:${port}`));

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => server.close(() => {
    store.close();
    process.exit(0);
  }));
}
