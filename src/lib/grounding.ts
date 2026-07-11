import type { Band, Confidence, Evidence, LeadPacket, ScoreBreakdown, WritebackOutcomeStatus } from "./contextai.ts";
import type { ScoringConfig } from "./config.ts";
import { defaultScoringConfig } from "./config.ts";
import type { ScoreDriver, ScoredLeadPacket } from "./scoring.ts";

export const groundingPromptVersion = "grounding-v1";
export const fallbackHook = "No grounded hook available — no recent verified signal found.";

export type GroundedClaim = {
  claim_id: string;
  text: string;
  evidence_ids: string[];
  driver: keyof ScoreBreakdown;
  hook: string | null;
};

export type GroundedExplanation = {
  priority_score: number | null;
  band: Band;
  confidence: Confidence;
  reason: string;
  reason_claim_ids: string[];
  hook_recommendation: string;
  hook_claim_ids: string[];
  missing_stale_data: string;
  crm_writeback: WritebackOutcomeStatus;
};

export type GroundingAudit = {
  prompt_version: string;
  model_id: string;
  evaluation_id: string;
  allowed_claim_ids: string[];
  evidence_ids: string[];
  outcome: "validated" | "fallback";
  failure?: "invalid_output" | "provider_failure";
};

const dayMs = 24 * 60 * 60 * 1000;
const blockedText = /ignore\s+(?:all\s+)?(?:previous\s+)?instructions?|system\s+prompt|developer\s+message|password|api[_ -]?key|race|ethnicity|religion|political|health|sexual orientation|trade union|financial distress|precise location/i;
const safeText = (value: string) => value.trim().length > 0 && value.length <= 160 && !blockedText.test(value);
const allEvidence = (lead: LeadPacket) => [
  ...lead.crm_context.evidence,
  ...lead.enrichment_fields.evidence,
  ...lead.intent_signals.evidence,
  ...lead.engagement_signals.evidence,
  ...lead.public_signals.flatMap((signal) => signal.evidence),
  ...lead.validation_evidence,
];
const statusFor = (source: Evidence["source_type"]) => source === "crm" ? "get_crm_lead"
  : source === "enrichment" ? "enrich_profile"
  : source === "intent" || source === "engagement" ? "fetch_intent_triggers"
  : source === "public_signal" ? "fetch_public_signals"
  : null;
const maxAge = (source: Evidence["source_type"], config: ScoringConfig) => source === "intent" ? config.freshness.intent.freshThroughDays
  : source === "engagement" ? config.freshness.engagement.freshThroughDays
  : source === "public_signal" ? config.freshness.publicSignal.freshThroughDays
  : source === "crm" ? config.freshness.contact.freshThroughDays
  : config.freshness.firmographic.freshThroughDays;
const eligible = (lead: LeadPacket, item: Evidence, config: ScoringConfig) => {
  const observedAt = item.source_published_at ?? item.source_updated_at ?? item.retrieved_at;
  const age = Math.floor((Date.parse(lead.evaluation_timestamp) - Date.parse(observedAt)) / dayMs);
  const step = statusFor(item.source_type);
  return config.sourcePolicy.approvedSourceTypes.includes(item.source_type) &&
    item.confidence !== "Low" && age >= 0 && age <= maxAge(item.source_type, config) &&
    (step === null || lead.tool_status[step].status === "success") &&
    safeText(item.source_name) && safeText(lead.lead_identity.company);
};

const claimFor = (lead: LeadPacket, item: Evidence, driver: ScoreDriver["category"]): Omit<GroundedClaim, "claim_id"> | null => {
  const company = lead.lead_identity.company;
  const source = item.source_name;
  const fields = item.field_values ?? {};
  let text: string | null = null;
  if (typeof fields.employees === "number") text = `${source} reports ${company} has ${fields.employees} employees.`;
  else if (typeof fields.revenue_band === "string" && safeText(fields.revenue_band)) text = `${source} reports ${company}'s revenue band is ${fields.revenue_band}.`;
  else if (Array.isArray(fields.tech_stack) && fields.tech_stack.every(safeText)) text = `${source} reports ${company} uses ${fields.tech_stack.join(", ")}.`;
  else if (fields.demo_request === true) text = `${source} recorded a demo request for ${company}.`;
  else if (fields.pricing_page_visit === true) text = `${source} recorded a pricing-page visit for ${company}.`;
  else if (typeof fields.replies === "number" && fields.replies > 0) text = `${source} recorded ${fields.replies} sales ${fields.replies === 1 ? "reply" : "replies"} for ${company}.`;
  else if (typeof fields.clicks === "number" && fields.clicks > 0) text = `${source} recorded ${fields.clicks} email ${fields.clicks === 1 ? "click" : "clicks"} for ${company}.`;
  else if (typeof fields.opens === "number" && fields.opens > 0) text = `${source} recorded ${fields.opens} email opens for ${company}; opens alone are weak engagement, not buying intent.`;
  else if (fields.surge === true) text = `${source} reported a category intent surge for ${company}.`;
  else if (typeof fields.routing_status === "string" && safeText(fields.routing_status)) text = `${source} records ${company}'s routing status as ${fields.routing_status}.`;
  else if (typeof fields.label === "string" && safeText(fields.label) && item.source_published_at) {
    const date = item.source_published_at.slice(0, 10);
    text = `${source} reported ${company}'s ${fields.label} on ${date}.`;
    return { text, evidence_ids: [item.evidence_id], driver, hook: `Reference ${company}'s ${fields.label}, reported by ${source} on ${date}.` };
  }
  return text ? { text, evidence_ids: [item.evidence_id], driver, hook: null } : null;
};

export const compileAllowedClaims = (
  lead: ScoredLeadPacket,
  config: ScoringConfig = defaultScoringConfig,
): GroundedClaim[] => {
  const evidence = new Map(allEvidence(lead).map((item) => [item.evidence_id, item]));
  const claims: GroundedClaim[] = [];
  for (const driver of lead.top_drivers) {
    for (const evidenceId of driver.evidence_ids) {
      const item = evidence.get(evidenceId);
      if (!item || !eligible(lead, item, config)) continue;
      const claim = claimFor(lead, item, driver.category);
      if (!claim || claims.some((candidate) => candidate.text === claim.text)) continue;
      claims.push({ ...claim, claim_id: `${driver.category}:${evidenceId}:${claims.length + 1}` });
    }
  }
  return claims;
};

const materialData = (lead: LeadPacket) => {
  const details = [
    lead.missing_fields.length ? `Missing: ${lead.missing_fields.join(", ")}.` : "",
    lead.stale_fields.length ? `Stale: ${lead.stale_fields.join(", ")}.` : "",
    lead.source_conflicts.length ? "A material source conflict requires review." : "",
  ].filter(Boolean);
  return details.join(" ") || "None material";
};
const driverLabel = (driver: ScoreDriver["category"]) => ({
  icp_fit: "ICP fit",
  high_intent_actions: "high-intent actions",
  engagement_quality: "engagement quality",
  public_timing_signals: "public timing signals",
  crm_process_context: "CRM process context",
  data_confidence: "data confidence",
})[driver];

export const fallbackGroundedExplanation = (lead: ScoredLeadPacket): GroundedExplanation => ({
  priority_score: lead.priority_score,
  band: lead.priority_band,
  confidence: lead.confidence,
  reason: lead.top_drivers.length
    ? `The score is driven by ${lead.top_drivers.slice(0, 2).map((driver) => driverLabel(driver.category)).join(" and ")}.`
    : "ContextAI cannot safely explain prioritization from the available evidence.",
  reason_claim_ids: [],
  hook_recommendation: fallbackHook,
  hook_claim_ids: [],
  missing_stale_data: materialData(lead),
  crm_writeback: lead.writeback_outcome.status,
});

const exactKeys = ["priority_score", "band", "confidence", "reason", "reason_claim_ids", "hook_recommendation", "hook_claim_ids", "missing_stale_data", "crm_writeback"];
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const stringIds = (value: unknown): value is string[] => Array.isArray(value) && value.every((item) => typeof item === "string") && new Set(value).size === value.length;

export const validateGroundedExplanation = (
  lead: ScoredLeadPacket,
  claims: GroundedClaim[],
  value: unknown,
): GroundedExplanation => {
  if (!isRecord(value) || Object.keys(value).length !== exactKeys.length || Object.keys(value).some((key) => !exactKeys.includes(key)) ||
    value.priority_score !== lead.priority_score || value.band !== lead.priority_band || value.confidence !== lead.confidence ||
    value.crm_writeback !== lead.writeback_outcome.status || value.missing_stale_data !== materialData(lead) ||
    typeof value.reason !== "string" || !stringIds(value.reason_claim_ids) || typeof value.hook_recommendation !== "string" || !stringIds(value.hook_claim_ids)) {
    throw new Error("Invalid grounded explanation");
  }
  const byId = new Map(claims.map((claim) => [claim.claim_id, claim]));
  const reasonClaims = value.reason_claim_ids.map((id) => byId.get(id));
  const hookClaims = value.hook_claim_ids.map((id) => byId.get(id));
  const topDrivers = [...new Set(claims.map((claim) => claim.driver))].slice(0, 2);
  if (reasonClaims.length < 1 || reasonClaims.length > 2 || reasonClaims.some((claim) => !claim) ||
    reasonClaims.some((claim, index) => claim?.driver !== topDrivers[index]) ||
    value.reason !== reasonClaims.map((claim) => claim?.text).join(" ") ||
    hookClaims.length > 1 || hookClaims.some((claim) => !claim?.hook) ||
    (hookClaims.length === 0 ? value.hook_recommendation !== fallbackHook : value.hook_recommendation !== hookClaims[0]?.hook)) {
    throw new Error("Invalid grounded explanation");
  }
  return value as GroundedExplanation;
};

export const formatGroundedExplanation = (value: GroundedExplanation) => [
  `Priority Score: ${value.priority_score === null ? "Data unavailable" : `${value.priority_score}/100`}`,
  `Band: ${value.band}`,
  `Confidence: ${value.confidence}`,
  `Reason: ${value.reason}`,
  `Hook Recommendation: ${value.hook_recommendation}`,
  `Missing / Stale Data: ${value.missing_stale_data}`,
  `CRM Writeback: ${value.crm_writeback}`,
].join("\n");
