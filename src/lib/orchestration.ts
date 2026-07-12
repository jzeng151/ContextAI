import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { createScoringRunContext, type ScoringRunContext } from "./config.ts";
import type { Evidence, LeadPacket, ManualReviewReason, ToolStatus, ToolTerminalStatus } from "./contextai.ts";
import { fallbackGroundedExplanation, groundingPromptVersion, type GroundedExplanation } from "./grounding.ts";
import { enrichProfile, fetchIntentTriggers, fetchPublicSignals, type EnrichProfileResult, type IntentTriggersResult, type PublicSignalsResult } from "./ingestion.ts";
import { explainLeadWithOpenRouter } from "./integrations.ts";
import { createEventRecorder } from "./instrumentation.ts";
import { RuntimeStore } from "./persistence.ts";
import { applyDeterministicScore, type ScoredLeadPacket } from "./scoring.ts";
import { assertTenantAccess, type RequestIdentity } from "./security.ts";
import { executeWriteback, hubSpotWritebackPolicyFor, planWriteback } from "./writeback.ts";

export type HubSpotCompany = Readonly<{ id: string; name: string; domain: string | null; archived?: boolean; primary?: boolean }>;
export type HubSpotLeadRecord = Readonly<{
  id: string;
  firstname?: string | null;
  lastname?: string | null;
  email?: string | null;
  jobtitle?: string | null;
  company?: string | null;
  owner?: string | null;
  assignedUserId?: string | null;
  source?: string | null;
  lifecycleStage?: string | null;
  routingStatus?: string | null;
  openOpportunityStatus?: "open" | "none" | "unknown";
  duplicateStatus?: "clear" | "suspected" | "confirmed";
  companies?: readonly HubSpotCompany[];
  updatedAt?: string;
  archived?: boolean;
}>;

export type AssignmentEvent = Readonly<{
  eventId: string;
  tenantId: string;
  contactId: string;
  ownerId: string;
  occurredAt: string;
  type: "new_owner" | "reassignment";
}>;

type Dependencies = Readonly<{
  getCrmLead: (contactId: string) => Promise<HubSpotLeadRecord>;
  enrich?: typeof enrichProfile;
  intent?: typeof fetchIntentTriggers;
  publicSignals?: typeof fetchPublicSignals;
  score?: typeof applyDeterministicScore;
  explain?: typeof explainLeadWithOpenRouter;
}>;

type EvaluationOptions = Readonly<{
  identity: RequestIdentity;
  idempotencyKey: string;
  contactId: string;
  store: RuntimeStore;
  dependencies: Dependencies;
  scoringContext?: ScoringRunContext;
  requestId?: string;
  evaluatedAt?: string;
}>;

const zeroBreakdown = { icp_fit: 0, high_intent_actions: 0, engagement_quality: 0, public_timing_signals: 0, crm_process_context: 0, data_confidence: 0 } as const;
const terminalDetail = (status: ToolTerminalStatus, message?: string) =>
  status === "success" || status === "no_result" ? message : message || "Data unavailable";
const toolResult = (status: ToolTerminalStatus, completedAt: string, detail?: string) => ({
  status,
  completed_at: completedAt,
  ...(terminalDetail(status, detail) ? { detail: terminalDetail(status, detail) } : {}),
});
const emptyStatuses = (at: string): ToolStatus => ({
  get_crm_lead: toolResult("skipped", at, "Not run."),
  enrich_profile: toolResult("skipped", at, "Not run."),
  fetch_intent_triggers: toolResult("skipped", at, "Not run."),
  fetch_public_signals: toolResult("skipped", at, "Not run."),
  deterministic_score: toolResult("skipped", at, "Not run."),
  evaluate_crm_writeback: toolResult("skipped", at, "Not run."),
});
const evidenceId = (...parts: string[]) => createHash("sha256").update(parts.join("|")).digest("hex").slice(0, 20);
const emailDomain = (email: string) => email.split("@")[1]?.trim().toLowerCase() ?? null;
const consumerDomains = new Set(["gmail.com", "yahoo.com", "hotmail.com", "outlook.com", "icloud.com", "aol.com"]);

const validationEvidence = (evaluationId: string, reason: ManualReviewReason, at: string, missing: string[] = []): Evidence => ({
  evidence_id: evidenceId(evaluationId, reason),
  source_name: "ContextAI validation",
  source_type: "validation",
  field_name: "manual_review_reason",
  field_value: missing.length ? missing : reason,
  field_values: { manual_review_reason: reason },
  source_updated_at: at,
  retrieved_at: at,
  confidence: "High",
  eligible_for_crm_writeback: false,
});

export const mapHubSpotLead = (
  record: HubSpotLeadRecord,
  ids: Readonly<{ requestId: string; evaluationId: string }>,
  evaluatedAt: string,
  scoreVersion: string,
): LeadPacket => {
  const companies = (record.companies ?? []).filter((company) => !company.archived);
  const primary = companies.filter((company) => company.primary);
  const selected = primary.length === 1 ? primary[0] : primary.length === 0 && companies.length === 1 ? companies[0] : undefined;
  const association = selected
    ? { status: "resolved" as const, basis: selected.primary ? "primary" as const : "sole" as const, candidate_account_ids: companies.map(({ id }) => id) }
    : companies.length > 1 || primary.length > 1
      ? { status: "ambiguous" as const, basis: null, candidate_account_ids: companies.map(({ id }) => id) }
      : { status: "none" as const, basis: null, candidate_account_ids: [] };
  const email = record.email?.trim().toLowerCase() || `unknown+${record.id}@invalid.local`;
  const fallbackDomain = emailDomain(email);
  const domain = selected?.domain?.trim().toLowerCase() || (!selected && fallbackDomain && !consumerDomains.has(fallbackDomain) && fallbackDomain !== "invalid.local" ? fallbackDomain : null);
  const duplicateStatus = record.duplicateStatus ?? "clear";
  const sourceUpdatedAt = record.updatedAt && Number.isFinite(Date.parse(record.updatedAt)) ? record.updatedAt : evaluatedAt;
  const crmFields = {
    owner: record.owner ?? "",
    source: record.source ?? "",
    lifecycle_stage: record.lifecycleStage ?? "",
    routing_status: record.routingStatus ?? "",
  };
  const crmEvidence: Evidence = {
    evidence_id: evidenceId(record.id, "crm", evaluatedAt),
    source_name: "HubSpot",
    source_type: "crm",
    field_name: "routing_status",
    field_value: record.routingStatus || "Data unavailable",
    field_values: Object.fromEntries(Object.entries(crmFields).filter(([, value]) => value)),
    source_record_id: record.id,
    source_updated_at: sourceUpdatedAt,
    retrieved_at: evaluatedAt,
    confidence: "High",
    eligible_for_crm_writeback: false,
  };
  const manualReasons: ManualReviewReason[] = [
    ...(association.status === "ambiguous" ? ["ambiguous_account" as const] : []),
    ...(duplicateStatus !== "clear" ? ["duplicate_risk" as const] : []),
    ...(!domain ? ["uncertain_identity" as const] : []),
    ...(record.archived || !record.owner || !["lead", "subscriber", "marketingqualifiedlead", "salesqualifiedlead", "opportunity"].includes(record.lifecycleStage ?? "") ? ["unsafe_workflow_state" as const] : []),
  ];
  const missing = [!record.email && "email", !record.owner && "owner", !domain && "corporate_domain"].filter((value): value is string => Boolean(value));
  const name = [record.firstname, record.lastname].filter(Boolean).join(" ").trim() || "Unknown contact";

  return {
    request_id: ids.requestId,
    evaluation_id: ids.evaluationId,
    lead_id: record.id,
    account_id: selected?.id ?? null,
    evaluation_timestamp: evaluatedAt,
    score_version: scoreVersion,
    priority_score: null,
    priority_band: "Needs Manual Review",
    confidence: "Low",
    manual_review_reasons: manualReasons,
    reason: "Evaluation is pending deterministic scoring.",
    hook: "No grounded hook available — no recent verified signal found.",
    score_breakdown: { ...zeroBreakdown },
    lead_identity: { name, title: record.jobtitle || "Data unavailable", company: selected?.name || record.company || domain || "Unknown company", email, domain },
    crm_context: {
      owner: record.owner ?? null,
      source: record.source ?? null,
      lifecycle_stage: record.lifecycleStage ?? null,
      routing_status: record.routingStatus ?? null,
      open_opportunity_status: record.openOpportunityStatus ?? "unknown",
      company_association: association,
      duplicate_status: duplicateStatus,
      domain_status: domain ? "verified" : "unresolved",
      evidence: [crmEvidence],
    },
    enrichment_fields: { tech_stack: [], evidence: [] },
    intent_signals: { surge: false, evidence: [] },
    engagement_signals: { opens: 0, clicks: 0, replies: 0, demo_request: false, pricing_page_visit: false, evidence: [] },
    public_signals: [],
    validation_evidence: manualReasons.map((reason) => validationEvidence(ids.evaluationId, reason, evaluatedAt, missing)),
    missing_fields: missing,
    stale_fields: [],
    source_conflicts: [],
    tool_status: { ...emptyStatuses(evaluatedAt), get_crm_lead: toolResult("success", evaluatedAt) },
    writeback_plan: { decision: "Review", reason: "Evaluation is pending deterministic scoring." },
    writeback_outcome: { status: "Flagged for Review", reason: "Evaluation is pending deterministic scoring.", recorded_at: evaluatedAt },
    allowed_claims: [],
    disallowed_claims: [],
  };
};

const ageDays = (at: string, updated?: string) => updated ? Math.floor((Date.parse(at) - Date.parse(updated)) / 86_400_000) : undefined;
const statusMessage = (result: { status: ToolTerminalStatus; message?: string }) => toolResult(result.status, new Date().toISOString(), result.message);
const publicPackets = (result: PublicSignalsResult, at: string) => result.signals.map((signal) => ({
  label: signal.label,
  source: signal.source,
  days_ago: Math.floor((Date.parse(at) - Date.parse(signal.published_at)) / 86_400_000),
  evidence: result.evidence.filter((item) => item.field_values?.label === signal.label && item.source_name === signal.source),
}));

const scoringFallback = (packet: LeadPacket, context: ScoringRunContext, at: string, error: unknown): ScoredLeadPacket => ({
  ...packet,
  score_version: context.score_version,
  priority_score: null,
  priority_band: "Needs Manual Review",
  confidence: "Low",
  manual_review_reasons: [...new Set([...packet.manual_review_reasons, "scoring_unavailable" as const])],
  score_breakdown: { ...zeroBreakdown },
  top_drivers: [],
  validation_evidence: [...packet.validation_evidence, validationEvidence(packet.evaluation_id, "scoring_unavailable", at)],
  tool_status: { ...packet.tool_status, deterministic_score: toolResult("unavailable", at, error instanceof Error ? error.message : "Deterministic scoring failed.") },
  writeback_plan: null,
  writeback_outcome: { status: "Data unavailable", reason: "Deterministic scoring was unavailable.", recorded_at: at },
});

const eventEvidence = (packet: LeadPacket) => [...packet.crm_context.evidence, ...packet.enrichment_fields.evidence, ...packet.intent_signals.evidence, ...packet.engagement_signals.evidence, ...packet.public_signals.flatMap(({ evidence }) => evidence), ...packet.validation_evidence].map(({ evidence_id }) => evidence_id);

export const evaluateLead = async (options: EvaluationOptions) => {
  assertTenantAccess(options.identity, options.identity.tenantId);
  const existing = options.store.getEvaluationByIdempotencyKey(options.identity, options.idempotencyKey);
  if (existing) return { ...existing, replayed: true as const };
  const at = options.evaluatedAt ?? new Date().toISOString();
  const context = options.scoringContext ?? createScoringRunContext(options.store.getActiveConfigVersion(options.identity));
  const writebackPolicy = hubSpotWritebackPolicyFor(context.config, context.score_version);
  const keyHash = createHash("sha256").update(`${options.identity.tenantId}|${options.idempotencyKey}`).digest("hex").slice(0, 24);
  const ids = { requestId: options.requestId ?? `request-${keyHash}`, evaluationId: `evaluation-${keyHash}` };
  let packet: LeadPacket;
  let assignedUserId: string | undefined;
  try {
    const crm = await options.dependencies.getCrmLead(options.contactId);
    assignedUserId = crm.assignedUserId ?? undefined;
    packet = mapHubSpotLead(crm, ids, at, context.score_version);
  } catch (error) {
    packet = mapHubSpotLead({ id: options.contactId }, ids, at, context.score_version);
    packet = {
      ...packet,
      crm_context: { owner: null, source: null, lifecycle_stage: null, routing_status: null, open_opportunity_status: "unknown", company_association: { status: "none", basis: null, candidate_account_ids: [] }, duplicate_status: "clear", domain_status: "unresolved", evidence: [] },
      validation_evidence: [validationEvidence(ids.evaluationId, "invalid_source_result", at), validationEvidence(ids.evaluationId, "uncertain_identity", at, ["crm_lead", "corporate_domain"])],
      missing_fields: ["crm_lead", "corporate_domain"],
      tool_status: { ...emptyStatuses(at), get_crm_lead: toolResult("unavailable", at, error instanceof Error ? error.message : "CRM retrieval failed.") },
    };
  }

  const enrichment = await (options.dependencies.enrich ?? enrichProfile)(packet.lead_identity.domain ?? "", { evaluatedAt: at });
  packet = { ...packet, enrichment_fields: enrichment.status === "success" ? { employees: enrichment.employees, revenue_band: enrichment.revenue_band, tech_stack: enrichment.tech_stack, last_updated_days_ago: ageDays(at, enrichment.last_updated), evidence: enrichment.evidence } : { tech_stack: [], evidence: [] }, tool_status: { ...packet.tool_status, enrich_profile: statusMessage(enrichment) } };

  const intent = await (options.dependencies.intent ?? fetchIntentTriggers)(packet.lead_identity.email, { evaluatedAt: at });
  packet = { ...packet, intent_signals: intent.status === "success" ? { surge: intent.surge, evidence: intent.evidence.filter(({ source_type }) => source_type === "intent") } : { surge: false, evidence: [] }, engagement_signals: intent.status === "success" ? { opens: intent.opens, clicks: intent.clicks, replies: intent.replies, demo_request: intent.demo_request, pricing_page_visit: intent.pricing_page_visit, evidence: intent.evidence.filter(({ source_type }) => source_type === "engagement") } : { opens: 0, clicks: 0, replies: 0, demo_request: false, pricing_page_visit: false, evidence: [] }, tool_status: { ...packet.tool_status, fetch_intent_triggers: statusMessage(intent) } };

  const signals = await (options.dependencies.publicSignals ?? fetchPublicSignals)(packet.lead_identity.company, { evaluatedAt: at });
  packet = { ...packet, public_signals: signals.status === "success" ? publicPackets(signals, at) : [], tool_status: { ...packet.tool_status, fetch_public_signals: statusMessage(signals) } };

  let scored: ScoredLeadPacket;
  try {
    packet = { ...packet, tool_status: { ...packet.tool_status, deterministic_score: toolResult("success", at) } };
    scored = (options.dependencies.score ?? applyDeterministicScore)(packet, context);
  } catch (error) {
    scored = scoringFallback(packet, context, at, error);
  }
  scored = {
    ...scored,
    validation_evidence: [
      ...scored.validation_evidence,
      ...scored.manual_review_reasons
        .filter((reason) => !scored.validation_evidence.some((item) => item.field_values?.manual_review_reason === reason))
        .map((reason) => validationEvidence(scored.evaluation_id, reason, at, scored.missing_fields)),
    ],
  };

  if (scored.tool_status.deterministic_score.status === "success") {
    try {
      scored = {
        ...scored,
        writeback_plan: scored.priority_band === "Needs Manual Review"
          ? { decision: "Review", reason: "Manual review is required before CRM writeback." }
          : { decision: "Eligible", reason: "The scored packet may proceed to writeback policy evaluation." },
        writeback_outcome: scored.priority_band === "Needs Manual Review"
          ? { status: "Flagged for Review", reason: "Manual review is required before CRM writeback.", recorded_at: at }
          : { status: "Skipped", reason: "Writeback policy evaluation is pending.", recorded_at: at },
        tool_status: { ...scored.tool_status, evaluate_crm_writeback: toolResult("success", at) },
      };
      const planned = planWriteback(scored, writebackPolicy);
      const decision = planned.outcome === "Flagged for Review" ? "Review" : planned.outcome;
      scored = {
        ...scored,
        writeback_plan: { decision, reason: planned.reason },
        writeback_outcome: { status: decision === "Review" ? "Flagged for Review" : decision === "Blocked" ? "Blocked" : "Skipped", reason: decision === "Eligible" ? "Dry run: live CRM writeback is disabled." : planned.reason, recorded_at: at },
        tool_status: { ...scored.tool_status, evaluate_crm_writeback: toolResult("success", at) },
      };
    } catch (error) {
      scored = { ...scored, writeback_plan: null, writeback_outcome: { status: "Data unavailable", reason: "Writeback evaluation failed.", recorded_at: at }, tool_status: { ...scored.tool_status, evaluate_crm_writeback: toolResult("unavailable", at, error instanceof Error ? error.message : "Writeback evaluation failed.") } };
    }
  }

  const result = scored.tool_status.deterministic_score.status === "success"
    ? await (options.dependencies.explain ?? explainLeadWithOpenRouter)(scored, context)
    : { explanation: fallbackGroundedExplanation(scored), claims: [], audit: { prompt_version: groundingPromptVersion, model_id: "not-called", evaluation_id: scored.evaluation_id, allowed_claim_ids: [], evidence_ids: [], outcome: "fallback" as const } };
  const explanation = result.explanation as GroundedExplanation;
  const finalPacket: LeadPacket = {
    ...scored,
    reason: explanation.reason,
    hook: explanation.hook_recommendation,
    allowed_claims: result.claims.map((claim) => ({ text: claim.text, evidence_ids: claim.evidence_ids })),
  };
  const saved = options.store.saveEvaluation({ tenantId: options.identity.tenantId, idempotencyKey: options.idempotencyKey, packet: finalPacket, assignedRepId: assignedUserId });
  if (!saved.created) return { ...options.store.getEvaluation(options.identity, saved.evaluationId)!, replayed: true as const };
  if (finalPacket.tool_status.evaluate_crm_writeback.status === "success" && options.identity.role === "revops_admin") {
    await executeWriteback(planWriteback(finalPacket, writebackPolicy), { store: options.store, tenantId: options.identity.tenantId, actorType: options.identity.role, actorId: options.identity.actorId, identity: options.identity, policy: writebackPolicy, mode: "dry-run" });
  }
  options.store.appendGroundingAudit(options.identity.tenantId, explanation, result.claims, result.audit);
  if (finalPacket.priority_band === "Needs Manual Review") options.store.appendReviewItem(options.identity, finalPacket.evaluation_id, finalPacket.manual_review_reasons.join(", "), finalPacket);
  const recordEvent = createEventRecorder(options.store);
  recordEvent({
    name: "evaluation.run", idempotencyKey: `${options.idempotencyKey}:evaluation.run`, tenantId: options.identity.tenantId,
    requestId: finalPacket.request_id, evaluationId: finalPacket.evaluation_id, leadId: finalPacket.lead_id, accountId: finalPacket.account_id,
    actorType: options.identity.role, actorId: options.identity.actorId, scoreVersion: context.score_version, configVersion: context.score_version,
    promptVersion: groundingPromptVersion, evidenceRefs: eventEvidence(finalPacket), retentionClass: "pilot_analytics_12_months", occurredAt: at,
    data: { outcome: Object.values(finalPacket.tool_status).some(({ status }) => !["success", "no_result"].includes(status)) ? "partial_failure" : "complete", priorityScore: finalPacket.priority_score, priorityBand: finalPacket.priority_band },
  });
  recordEvent({
    name: "writeback.outcome", idempotencyKey: `${options.idempotencyKey}:writeback.outcome`, tenantId: options.identity.tenantId,
    requestId: finalPacket.request_id, evaluationId: finalPacket.evaluation_id, leadId: finalPacket.lead_id, accountId: finalPacket.account_id,
    actorType: options.identity.role, actorId: options.identity.actorId, scoreVersion: context.score_version, configVersion: context.score_version,
    evidenceRefs: [], retentionClass: "writeback_audit_24_months", occurredAt: at,
    data: { writebackId: `${finalPacket.evaluation_id}:${writebackPolicy.version}`, outcome: finalPacket.writeback_outcome.status },
  });
  return { packet: finalPacket, outcome: options.store.getEvaluation(options.identity, saved.evaluationId)!.outcome, replayed: false as const };
};

export const runMorningEvaluation = async (input: Omit<EvaluationOptions, "idempotencyKey" | "contactId"> & Readonly<{ ownerId: string; scheduledFor: string; listAssignedOpen: (ownerId: string) => Promise<readonly HubSpotLeadRecord[]>; concurrency?: number }>) => {
  const records = await input.listAssignedOpen(input.ownerId);
  const eligible = records.filter((record) => !record.archived && record.owner === input.ownerId && record.routingStatus !== "closed");
  const concurrency = Math.max(1, input.concurrency ?? 4);
  const results: Array<Awaited<ReturnType<typeof evaluateLead>> | { skipped: true; contactId: string; reason: string }> = records
    .filter((record) => !eligible.includes(record))
    .map((record) => ({ skipped: true as const, contactId: record.id, reason: record.archived ? "Archived contact." : record.owner !== input.ownerId ? "Contact is assigned to another owner." : "Contact is not open." }));
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, eligible.length) }, async () => {
    while (next < eligible.length) {
      const record = eligible[next++];
      results.push(await evaluateLead({ ...input, contactId: record.id, evaluatedAt: input.scheduledFor, idempotencyKey: `morning:${input.ownerId}:${input.scheduledFor.slice(0, 10)}:${record.id}` }));
    }
  }));
  return results;
};

export const verifyAssignmentSignature = (rawBody: string, signature: string | undefined, secret: string) => {
  if (!signature || !secret) return false;
  const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
  const left = Buffer.from(signature.replace(/^sha256=/, ""), "hex");
  const right = Buffer.from(expected, "hex");
  return left.length === right.length && timingSafeEqual(left, right);
};

export const parseHubSpotAssignmentEvents = (value: unknown, tenantId: string): AssignmentEvent[] => {
  const events = Array.isArray(value) ? value : [value];
  return events.map((item) => {
    if (!item || typeof item !== "object") throw new Error("Malformed assignment event");
    const raw = item as Record<string, unknown>;
    const occurred = typeof raw.occurredAt === "number" ? new Date(raw.occurredAt).toISOString() : String(raw.occurredAt ?? "");
    const event: AssignmentEvent = {
      eventId: String(raw.eventId ?? raw.id ?? ""),
      tenantId: String(raw.tenantId ?? tenantId),
      contactId: String(raw.contactId ?? raw.objectId ?? ""),
      ownerId: String(raw.ownerId ?? raw.propertyValue ?? ""),
      occurredAt: occurred,
      type: raw.type === "new_owner" ? "new_owner" : "reassignment",
    };
    if (raw.propertyName !== undefined && raw.propertyName !== "hubspot_owner_id") throw new Error("Webhook is not an owner-assignment event");
    return event;
  });
};

export const handleAssignmentEvent = async (event: AssignmentEvent, input: Omit<EvaluationOptions, "idempotencyKey" | "contactId" | "requestId" | "evaluatedAt">) => {
  if (![event.eventId, event.tenantId, event.contactId, event.ownerId].every((value) => value.trim()) || !Number.isFinite(Date.parse(event.occurredAt))) throw new Error("Malformed assignment event");
  assertTenantAccess(input.identity, event.tenantId);
  return evaluateLead({ ...input, contactId: event.contactId, requestId: event.eventId, evaluatedAt: event.occurredAt, idempotencyKey: `assignment:${event.eventId}` });
};
