import type { LeadPacket } from "./contextai.ts";
import { dashboardOutcomeEvents, dashboardPromptVersion } from "./dashboard.ts";
import { assertPilotEvent, createEventRecorder, type ActionType, type PilotEvent } from "./instrumentation.ts";
import type { RuntimeStore } from "./persistence.ts";
import { verifyHubSpotRequestSignature, type RequestIdentity } from "./security.ts";

type Headers = Readonly<Record<string, string | string[] | undefined>>;
type CrmRequest = Readonly<{ method: string; url: string; headers: Headers; body: string }>;
type CrmResponse = Readonly<{ status: number; body: unknown }>;
type ViewInput = Readonly<{ operation: "view"; objectId: string; objectTypeId: "0-1" | "0-2" }>;
type OutcomeInput = Readonly<{ operation: "outcome"; objectId: string; objectTypeId: "0-1" | "0-2"; disposition: "accepted" | "ignored" | "overridden"; actionType?: ActionType }>;

const evidence = (packet: LeadPacket) => [
  ...packet.crm_context.evidence,
  ...packet.enrichment_fields.evidence,
  ...packet.intent_signals.evidence,
  ...packet.engagement_signals.evidence,
  ...packet.public_signals.flatMap((signal) => signal.evidence),
  ...packet.validation_evidence,
];

export const crmCardView = (packet: LeadPacket) => {
  const byId = new Map(evidence(packet).map((item) => [item.evidence_id, item]));
  return {
    evaluationId: packet.evaluation_id,
    evaluatedAt: packet.evaluation_timestamp,
    score: packet.priority_score,
    band: packet.priority_band,
    confidence: packet.confidence,
    drivers: packet.allowed_claims.slice(0, 2).map((claim) => ({
      text: claim.text,
      sources: claim.evidence_ids.map((id) => byId.get(id)).filter((item) => item !== undefined).map((item) => ({
        name: item.source_name,
        url: item.source_type === "public_signal" ? item.source_url ?? null : null,
      })),
    })),
    hook: packet.hook,
    dataQuality: {
      missing: packet.missing_fields,
      stale: packet.stale_fields,
      conflicts: packet.source_conflicts,
      manualReview: packet.manual_review_reasons,
      failedSources: Object.entries(packet.tool_status)
        .filter(([, result]) => !["success", "no_result"].includes(result.status))
        .map(([source, result]) => ({ source, status: result.status })),
    },
    writeback: packet.writeback_outcome,
    scoreVersion: packet.score_version,
    promptVersion: dashboardPromptVersion,
  };
};

const header = (headers: Headers, name: string) => {
  const value = headers[name] ?? headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
};
const text = (value: unknown) => typeof value === "string" && value.trim() ? value.trim() : null;
const crmInput = (value: unknown): ViewInput | OutcomeInput => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Request body is invalid");
  const input = value as Record<string, unknown>;
  if (!text(input.objectId) || !["0-1", "0-2"].includes(String(input.objectTypeId))) throw new Error("CRM record context is invalid");
  if (input.operation === "view") return { operation: "view", objectId: String(input.objectId), objectTypeId: input.objectTypeId as "0-1" | "0-2" };
  if (input.operation !== "outcome" || !["accepted", "ignored", "overridden"].includes(String(input.disposition)) ||
      (input.actionType !== undefined && !["call", "email", "sequence", "manual_enrichment", "nurture", "disqualify"].includes(String(input.actionType)))) {
    throw new Error("Recommendation outcome is invalid");
  }
  return { operation: "outcome", objectId: String(input.objectId), objectTypeId: input.objectTypeId as "0-1" | "0-2", disposition: input.disposition as OutcomeInput["disposition"], ...(input.actionType ? { actionType: input.actionType as ActionType } : {}) };
};

const viewEvents = (packet: LeadPacket, identity: RequestIdentity, seed: string): PilotEvent[] => [{
  name: "lead.viewed", idempotencyKey: `${seed}:lead.viewed`, tenantId: identity.tenantId, requestId: packet.request_id,
  evaluationId: packet.evaluation_id, leadId: packet.lead_id, accountId: packet.account_id, actorType: "rep", actorId: identity.actorId,
  scoreVersion: packet.score_version, configVersion: packet.score_version, promptVersion: dashboardPromptVersion, evidenceRefs: [],
  retentionClass: "pilot_analytics_12_months", occurredAt: new Date(Number(seed.split(":").at(-1))).toISOString(), data: { surface: "crm_widget" },
}, {
  name: "score.shown", idempotencyKey: `${seed}:score.shown`, tenantId: identity.tenantId, requestId: packet.request_id,
  evaluationId: packet.evaluation_id, leadId: packet.lead_id, accountId: packet.account_id, actorType: "rep", actorId: identity.actorId,
  scoreVersion: packet.score_version, configVersion: packet.score_version, promptVersion: dashboardPromptVersion, evidenceRefs: [],
  retentionClass: "pilot_analytics_12_months", occurredAt: new Date(Number(seed.split(":").at(-1))).toISOString(),
  data: { priorityScore: packet.priority_score, priorityBand: packet.priority_band, surface: "crm_widget" },
}];

export const handleCrmExtensionRequest = (request: CrmRequest, store: RuntimeStore, env: Record<string, string | undefined> = process.env): CrmResponse => {
  const timestamp = header(request.headers, "x-hubspot-request-timestamp");
  const baseUrl = env.CONTEXTAI_API_URL;
  const clientSecret = env.HUBSPOT_CLIENT_SECRET ?? "";
  if (!baseUrl || !verifyHubSpotRequestSignature({ method: request.method, uri: `${new URL(baseUrl).origin}${request.url}`, body: request.body, signature: header(request.headers, "x-hubspot-signature-v3"), timestamp, clientSecret })) {
    return { status: 401, body: { error: "Invalid HubSpot request signature" } };
  }
  try {
    const url = new URL(request.url, baseUrl);
    const portalId = text(url.searchParams.get("portalId"));
    const userId = text(url.searchParams.get("userId"));
    if (!portalId || !userId) return { status: 403, body: { error: "HubSpot account and user context are required" } };
    const tenantId = store.tenantForHubSpotAccount(portalId);
    if (!tenantId) return { status: 403, body: { error: "HubSpot account is not connected" } };
    const input = crmInput(JSON.parse(request.body));
    const identity = { requestId: `crm-card:${timestamp}`, tenantId, actorId: userId, role: "rep" as const };
    const result = store.getLatestEvaluationForCrmRecord(identity, input.objectTypeId, input.objectId);
    if (!result) return { status: 404, body: { error: "No assigned ContextAI evaluation is available for this record" } };
    const seed = `crm_widget:${result.packet.evaluation_id}:${userId}:${timestamp}`;
    const record = createEventRecorder(store);
    if (input.operation === "view") {
      viewEvents(result.packet, identity, seed).forEach((event) => { assertPilotEvent(event); record(event); });
      return { status: 200, body: crmCardView(result.packet) };
    }
    dashboardOutcomeEvents({ packet: result.packet, tenantId, actorType: "rep", actorId: userId, configVersion: result.packet.score_version, occurredAt: new Date(Number(timestamp)).toISOString(), idempotencySeed: seed, disposition: input.disposition, actionType: input.actionType }).forEach(record);
    return { status: 202, body: { recorded: true } };
  } catch (error) {
    return { status: 400, body: { error: error instanceof Error ? error.message : "Request failed" } };
  }
};
