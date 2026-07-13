import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { pathToFileURL } from "node:url";
import { createConfigDraft, type ScoringConfig, type ScoringRunContext } from "./lib/config.ts";
import { getHubSpotLeadRecord, listAllHubSpotContacts, listAssignedOpenHubSpotLeads, writeHubSpotProperties } from "./lib/integrations.ts";
import { evaluateLead, handleAssignmentEvent, parseHubSpotAssignmentEvents, runMorningEvaluation, verifyAssignmentSignature } from "./lib/orchestration.ts";
import { RuntimeStore } from "./lib/persistence.ts";
import { createPilotReport, exportPilotReport, reportFiltersFrom } from "./lib/reporting.ts";
import { adminOriginsFromEnv, authenticateBearer, isLoopbackAddress, type RequestIdentity } from "./lib/security.ts";
import { secretKeyFromEnv } from "./lib/secrets.ts";
import { handleCrmExtensionRequest } from "./lib/crm-extension.ts";
import { hubSpotWritebackPolicy, hubSpotWritebackPolicyFor, rollbackLeadWriteback, rollbackWriteback } from "./lib/writeback.ts";
import { hubSpotDashboardPackets } from "./lib/dashboard.ts";
import { compileAllowedClaims, fallbackGroundedExplanation, groundingPromptVersion } from "./lib/grounding.ts";
import type { ScoredLeadPacket } from "./lib/scoring.ts";
import { completeHubSpotOAuth, createAdminSession, OnboardingError, startHubSpotOAuth } from "./lib/onboarding.ts";

const store = new RuntimeStore();
const host = process.env.HOST ?? "127.0.0.1";
const port = Number(process.env.PORT ?? 4000);
const adminOrigins = adminOriginsFromEnv(process.env.CONTEXTAI_ADMIN_ORIGIN);
const localDemo = process.env.CONTEXTAI_LOCAL_DEMO === "1";
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
const oauthFailure = (response: Parameters<Parameters<typeof createServer>[0]>[1], status: number) => {
  let returnUrl = "/";
  try {
    const appUrl = new URL(process.env.CONTEXTAI_APP_URL ?? "");
    if (/^https?:$/.test(appUrl.protocol) && !appUrl.username && !appUrl.password && !appUrl.search && !appUrl.hash) {
      returnUrl = `${appUrl.toString().replace(/\/+$/, "")}/admin?hubspot=error`;
    }
  } catch { /* A fixed relative fallback keeps configuration errors safe. */ }
  const href = returnUrl.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  response.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" });
  response.end(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>HubSpot connection failed</title><body><main><h1>HubSpot connection failed</h1><p>The connection could not be completed. Return to ContextAI and try again.</p><a href="${href}">Return to ContextAI</a></main></body></html>`);
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
  return { ...identity, requestId: randomUUID() };
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
const dashboardIdentity = (request: Parameters<Parameters<typeof createServer>[0]>[0], response: Parameters<Parameters<typeof createServer>[0]>[1]) => {
  if (request.headers.authorization) return adminIdentity(request, response);
  const forwarded = ["forwarded", "x-forwarded-for", "x-forwarded-host", "x-forwarded-proto"].some((name) => request.headers[name]);
  const directLoopback = isLoopbackAddress(host) && isLoopbackAddress(request.socket.localAddress) && isLoopbackAddress(request.socket.remoteAddress) && !forwarded;
  if (localDemo && directLoopback && (!request.headers.origin || adminOrigins.has(request.headers.origin))) {
    return { requestId: `dashboard-${Date.now()}`, tenantId, actorId: "local-demo", role: "revops_admin" as const };
  }
  json(response, 401, { error: "Authentication required" });
  return null;
};
const dashboardContacts = async (identity: RequestIdentity) => {
  const worker = { ...identity, actorId: "dashboard-worker", role: "system" as const };
  return { worker, contacts: await listAllHubSpotContacts(await hubSpotConfigFor(worker)) };
};

export const handleRequest = async (request: Parameters<Parameters<typeof createServer>[0]>[0], response: Parameters<Parameters<typeof createServer>[0]>[1]) => {
  const origin = request.headers.origin;
  if (origin && adminOrigins.has(origin)) {
    response.setHeader("Access-Control-Allow-Origin", origin);
    response.setHeader("Vary", "Origin");
    response.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
    response.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  }
  if (request.method === "OPTIONS") {
    if (origin && !adminOrigins.has(origin)) return json(response, 403, { error: "Origin not allowed" });
    response.writeHead(204).end();
    return;
  }
  const requestUrl = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
  const path = requestUrl.pathname;
  if (request.method === "GET" && path === "/health") {
    json(response, 200, { status: "ok" });
    return;
  }
  try {
    if (request.method === "POST" && path === "/auth/session") {
      response.setHeader("Cache-Control", "no-store");
      let bootstrapToken: unknown;
      try {
        const input = JSON.parse(await body(request)) as { bootstrapToken?: unknown };
        bootstrapToken = input?.bootstrapToken;
      } catch {
        return json(response, 401, { error: "Authentication failed" });
      }
      try {
        return json(response, 200, createAdminSession(bootstrapToken));
      } catch (error) {
        return json(response, error instanceof OnboardingError ? error.status : 503, {
          error: error instanceof OnboardingError ? error.publicMessage : "Authentication is unavailable"
        });
      }
    }
    if (request.method === "POST" && path === "/oauth/hubspot/start") {
      response.setHeader("Cache-Control", "no-store");
      const identity = adminIdentity(request, response);
      if (!identity) return;
      try {
        return json(response, 200, startHubSpotOAuth(identity, store));
      } catch (error) {
        return json(response, error instanceof OnboardingError ? error.status : 503, { error: "HubSpot OAuth is unavailable" });
      }
    }
    if (request.method === "GET" && path === "/oauth/hubspot/callback") {
      try {
        const redirect = await completeHubSpotOAuth({
          code: requestUrl.searchParams.get("code"),
          state: requestUrl.searchParams.get("state"),
          error: requestUrl.searchParams.get("error"),
        }, store);
        response.writeHead(302, { Location: redirect, "Cache-Control": "no-store" }).end();
      } catch (error) {
        oauthFailure(response, error instanceof OnboardingError ? error.status : 400);
      }
      return;
    }
    if (request.method === "GET" && path === "/dashboard") {
      const identity = dashboardIdentity(request, response);
      if (!identity) return;
      const { contacts } = await dashboardContacts(identity);
      return json(response, 200, { leads: hubSpotDashboardPackets(store, identity, contacts.map(({ id }) => id)), contacts: contacts.length, tenantId: identity.tenantId });
    }
    if (request.method === "POST" && path === "/dashboard/refresh") {
      const identity = dashboardIdentity(request, response);
      if (!identity) return;
      const { worker, contacts } = await dashboardContacts(identity);
      const refreshedAt = new Date().toISOString();
      const dependencies = {
        ...hubSpotDependencies(worker),
        ...(process.env.CONTEXTAI_ALLOW_MODEL_DATA === "1" ? {} : {
          explain: async (lead: ScoredLeadPacket, context: ScoringRunContext) => {
            const claims = compileAllowedClaims(lead, context.config);
            return {
              explanation: fallbackGroundedExplanation(lead),
              claims,
              audit: {
                prompt_version: groundingPromptVersion,
                model_id: "local-grounded-fallback",
                evaluation_id: lead.evaluation_id,
                allowed_claim_ids: claims.map(({ claim_id }) => claim_id),
                evidence_ids: [...new Set(claims.flatMap(({ evidence_ids }) => evidence_ids))],
                outcome: "fallback" as const,
              },
            };
          },
        }),
      };
      const results: PromiseSettledResult<Awaited<ReturnType<typeof evaluateLead>>>[] = [];
      // ponytail: fixed batches bound provider bursts; use a worker pool if refresh latency matters.
      for (let index = 0; index < contacts.length; index += 4) {
        results.push(...await Promise.allSettled(contacts.slice(index, index + 4).map(({ id }) => evaluateLead({
          identity,
          idempotencyKey: `dashboard:${refreshedAt}:${id}`,
          contactId: id,
          evaluatedAt: refreshedAt,
          recordPilotOwner: false,
          store,
          dependencies,
        }))));
      }
      return json(response, 200, {
        leads: results.flatMap((result) => result.status === "fulfilled" ? [result.value.packet] : []),
        contacts: contacts.length,
        analyzed: results.filter(({ status }) => status === "fulfilled").length,
        failed: results.filter(({ status }) => status === "rejected").length,
        errors: results.flatMap((result) => result.status === "rejected" ? [result.reason instanceof Error ? result.reason.message : "Analysis failed"] : []),
        refreshedAt,
        tenantId: identity.tenantId,
      });
    }
    if (request.method === "GET" && (path === "/reports/pilot" || path === "/reports/pilot.csv")) {
      const identity = adminIdentity(request, response);
      if (!identity) return;
      const url = new URL(request.url ?? path, `http://${request.headers.host ?? "localhost"}`);
      const report = createPilotReport(store.database, identity.tenantId, reportFiltersFrom(url.searchParams));
      store.recordReportAccess(identity, path.endsWith(".csv") ? "csv" : "json");
      if (path === "/reports/pilot.csv") {
        response.writeHead(200, { "content-type": "text/csv; charset=utf-8" });
        response.end(exportPilotReport(report));
        return;
      }
      return json(response, 200, report);
    }
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
};

export const closeRuntimeStore = () => store.close();

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const server = createServer(handleRequest);
  server.listen(port, host, () => console.log(`ContextAI server listening on http://${host}:${port}`));
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => server.close(() => {
      store.close();
      process.exit(0);
    }));
  }
}
