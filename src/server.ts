import { createServer } from "node:http";
import { getHubSpotLeadRecord, listAssignedOpenHubSpotLeads } from "./lib/integrations.ts";
import { handleAssignmentEvent, parseHubSpotAssignmentEvents, runMorningEvaluation, verifyAssignmentSignature } from "./lib/orchestration.ts";
import { RuntimeStore } from "./lib/persistence.ts";
import { authenticateBearer, type RequestIdentity } from "./lib/security.ts";
import { secretKeyFromEnv } from "./lib/secrets.ts";

const store = new RuntimeStore();
const host = process.env.HOST ?? "127.0.0.1";
const port = Number(process.env.PORT ?? 4000);
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
const hubSpotDependencies = (identity: RequestIdentity) => {
  const integrationId = process.env.HUBSPOT_INTEGRATION_ID;
  if (!integrationId) throw new Error("HUBSPOT_INTEGRATION_ID is required");
  const config = async () => ({ accessToken: await store.getHubSpotAccessToken(identity, integrationId, secretKeyFromEnv()) });
  return {
    getCrmLead: async (contactId: string) => getHubSpotLeadRecord(contactId, await config()),
    listAssignedOpen: async (ownerId: string) => listAssignedOpenHubSpotLeads(ownerId, await config()),
  };
};

const server = createServer(async (request, response) => {
  const path = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`).pathname;
  if (request.method === "GET" && path === "/health") {
    json(response, 200, { status: "ok" });
    return;
  }
  try {
    const reviewDecision = request.method === "POST" && path.match(/^\/admin\/reviews\/([^/]+)\/decision$/);
    if (reviewDecision) {
      let identity: RequestIdentity;
      try {
        identity = authenticateBearer(request.headers.authorization);
      } catch {
        return json(response, 401, { error: "Authentication required" });
      }
      if (identity.tenantId !== tenantId || identity.role !== "revops_admin") return json(response, 403, { error: "RevOps Admin access required" });
      const input = JSON.parse(await body(request)) as { decision?: string; note?: string };
      if ((input.decision !== "resolved" && input.decision !== "dismissed") || !input.note?.trim()) return json(response, 400, { error: "decision and note are required" });
      return json(response, 200, store.decideReviewItem(identity, decodeURIComponent(reviewDecision[1]!), input.decision, input.note));
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
