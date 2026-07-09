export type Band = "Hot" | "Warm" | "Cold" | "Needs Manual Review";
export type Confidence = "High" | "Medium" | "Low";
export type SourceType = "crm" | "enrichment" | "intent" | "public_signal";
export type WritebackDecision = "Eligible" | "Review" | "Skipped" | "Blocked";

type EvidenceValue = string | number | boolean | string[];

type EvidenceBase = {
  source_name: string;
  source_type: SourceType;
  source_url?: string;
  retrieved_at: string;
  source_published_at?: string;
  source_updated_at?: string;
  confidence: Confidence;
  eligible_for_crm_writeback: boolean;
};

export type Evidence = EvidenceBase & (
  | { field_value: EvidenceValue; event_value?: EvidenceValue }
  | { field_value?: EvidenceValue; event_value: EvidenceValue }
);

export type Claim = {
  text: string;
  evidence_source: string;
};

export type ScoreBreakdown = {
  icp_fit: number;
  high_intent_actions: number;
  engagement_quality: number;
  public_timing_signals: number;
  crm_process_context: number;
  data_confidence: number;
};

export type LeadPacket = {
  lead_id: string;
  account_id: string;
  evaluation_timestamp: string;
  score_version: string;
  priority_score: number | null;
  priority_band: Band;
  confidence: Confidence;
  reason: string;
  hook: string;
  score_breakdown: ScoreBreakdown;
  lead_identity: {
    name: string;
    title: string;
    company: string;
    email: string;
    domain: string;
  };
  crm_context: {
    owner: string;
    source: string;
    stage: string;
    evidence: Evidence[];
  };
  enrichment_fields: {
    employees?: number;
    revenue_band?: string;
    tech_stack: string[];
    last_updated_days_ago?: number;
    evidence: Evidence[];
  };
  intent_signals: {
    opens: number;
    clicks: number;
    replies: number;
    demo_request: boolean;
    pricing_page_visit: boolean;
    surge: boolean;
    evidence: Evidence[];
  };
  public_signals: Array<{
    label: string;
    source: string;
    days_ago: number;
    evidence: Evidence[];
  }>;
  missing_fields: string[];
  stale_fields: string[];
  source_conflicts: string[];
  writeback_recommendation: {
    decision: WritebackDecision;
    reason: string;
  };
  allowed_claims: Claim[];
  disallowed_claims: string[];
};

export const scoreLabel = (lead: LeadPacket) =>
  lead.priority_score === null ? "N/A" : `${lead.priority_score}/100`;

export const freshnessLabel = (daysAgo?: number) => {
  if (daysAgo === undefined) return "Data unavailable";
  if (daysAgo > 90) return `Stale (${daysAgo} days old)`;
  return `Fresh (${daysAgo} days old)`;
};

const fallbackHook = "No grounded hook available - no recent verified signal found.";
const normalized = (value: EvidenceValue) => String(value).toLowerCase();
const maxWritebackAgeMs = 90 * 24 * 60 * 60 * 1000;
const keywords = (value: string) => normalized(value).split(/[^a-z0-9]+/).filter((word) => word.length > 3);

const hasAllowedHookClaim = (lead: LeadPacket, signal: LeadPacket["public_signals"][number], item: Evidence) => {
  const company = normalized(lead.lead_identity.company);
  const source = normalized(item.source_name);
  const signalWords = keywords(signal.label);
  return lead.allowed_claims.some((claim) => {
    const text = normalized(claim.text);
    return normalized(claim.evidence_source).includes(source) && text.includes(company) && signalWords.some((word) => text.includes(word));
  });
};

const hasHookEvidence = (lead: LeadPacket) => {
  const hook = normalized(lead.hook);
  if (!hook.includes(normalized(lead.lead_identity.company))) return false;
  return lead.public_signals.some((signal) => {
    if (signal.evidence.length === 0 || !hook.includes(normalized(signal.label))) return false;
    return signal.evidence.some((item) =>
      hook.includes(normalized(item.field_value ?? item.event_value ?? signal.label)) && hasAllowedHookClaim(lead, signal, item)
    );
  });
};

export const groundedHook = (lead: LeadPacket) =>
  lead.hook !== fallbackHook && hasHookEvidence(lead) ? lead.hook : fallbackHook;

const isFreshHighConfidenceWritebackEvidence = (item: Evidence, evaluatedAt: string) => {
  const ageMs = Date.parse(evaluatedAt) - Date.parse(item.source_updated_at ?? "");
  return (
    item.source_type === "enrichment" &&
    item.confidence === "High" &&
    item.eligible_for_crm_writeback &&
    ageMs >= 0 &&
    ageMs <= maxWritebackAgeMs
  );
};

export const isWritebackEligible = (lead: LeadPacket) =>
  lead.writeback_recommendation.decision === "Eligible" &&
  (lead.enrichment_fields.last_updated_days_ago ?? Infinity) <= 90 &&
  lead.source_conflicts.length === 0 &&
  lead.enrichment_fields.evidence.some((item) => isFreshHighConfidenceWritebackEvidence(item, lead.evaluation_timestamp)) &&
  lead.enrichment_fields.evidence
    .filter((item) => item.source_type === "enrichment")
    .every((item) => isFreshHighConfidenceWritebackEvidence(item, lead.evaluation_timestamp));

export const hasOnlyWeakOpenIntent = (lead: LeadPacket) =>
  lead.intent_signals.opens > 0 &&
  lead.intent_signals.clicks === 0 &&
  lead.intent_signals.replies === 0 &&
  !lead.intent_signals.demo_request &&
  !lead.intent_signals.pricing_page_visit &&
  !lead.intent_signals.surge;

export const toolRun = [
  "get_crm_lead",
  "enrich_profile",
  "fetch_intent_triggers",
  "fetch_public_signals",
  "deterministic_score",
  "llm_explanation",
  "write_crm_enrichment"
] as const;
