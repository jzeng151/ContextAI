export type Band = "Hot" | "Warm" | "Cold" | "Needs Manual Review";
export type Confidence = "High" | "Medium" | "Low";
export type SourceType = "crm" | "enrichment" | "intent" | "engagement" | "public_signal" | "validation";
export type WritebackDecision = "Eligible" | "Review" | "Skipped" | "Blocked";
export type WritebackOutcomeStatus = "Written" | "Skipped" | "Flagged for Review" | "Blocked" | "Data unavailable";
export type ManualReviewReason =
  | "missing_required_data"
  | "uncertain_identity"
  | "duplicate_risk"
  | "ambiguous_account"
  | "invalid_source_result"
  | "source_conflict"
  | "unsafe_workflow_state"
  | "scoring_unavailable";

export const requiredToolSteps = [
  "get_crm_lead",
  "enrich_profile",
  "fetch_intent_triggers",
  "fetch_public_signals",
  "deterministic_score",
  "evaluate_crm_writeback"
] as const;

export type RequiredToolStep = typeof requiredToolSteps[number];
export type ToolTerminalStatus = "success" | "no_result" | "unavailable" | "timeout" | "rate_limited" | "invalid_result" | "skipped";
export type ToolStatus = Record<RequiredToolStep, {
  status: ToolTerminalStatus;
  completed_at: string;
  detail?: string;
}>;

type EvidenceValue = string | number | boolean | string[];

type EvidenceBase = {
  evidence_id: string;
  source_name: string;
  source_type: SourceType;
  field_name?: string;
  field_values?: Record<string, EvidenceValue>;
  source_url?: string;
  source_record_id?: string;
  retrieved_at: string;
  source_published_at?: string;
  source_updated_at?: string;
  confidence: Confidence;
  eligible_for_crm_writeback: boolean;
};

export type Evidence = EvidenceBase & (
  | { field_value: EvidenceValue; event_value?: never }
  | { field_value?: never; event_value: EvidenceValue }
);

export type Claim = {
  text: string;
  evidence_ids: string[];
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
  request_id: string;
  evaluation_id: string;
  lead_id: string;
  account_id: string | null;
  evaluation_timestamp: string;
  score_version: string;
  priority_score: number | null;
  priority_band: Band;
  confidence: Confidence;
  manual_review_reasons: ManualReviewReason[];
  reason: string;
  hook: string;
  score_breakdown: ScoreBreakdown;
  lead_identity: {
    name: string;
    title: string;
    company: string;
    email: string;
    domain: string | null;
  };
  crm_context: {
    owner: string | null;
    source: string | null;
    lifecycle_stage: string | null;
    routing_status: string | null;
    open_opportunity_status: "open" | "none" | "unknown";
    company_association: {
      status: "resolved" | "none" | "ambiguous";
      basis: "primary" | "sole" | null;
      candidate_account_ids: string[];
    };
    duplicate_status: "clear" | "suspected" | "confirmed";
    domain_status: "verified" | "unresolved" | "conflicting";
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
    surge: boolean;
    evidence: Evidence[];
  };
  engagement_signals: {
    opens: number;
    clicks: number;
    replies: number;
    demo_request: boolean;
    pricing_page_visit: boolean;
    evidence: Evidence[];
  };
  public_signals: Array<{
    label: string;
    source: string;
    days_ago: number;
    evidence: Evidence[];
  }>;
  validation_evidence: Evidence[];
  missing_fields: string[];
  stale_fields: string[];
  source_conflicts: string[];
  tool_status: ToolStatus;
  writeback_plan: {
    decision: WritebackDecision;
    reason: string;
  } | null;
  writeback_outcome: {
    status: WritebackOutcomeStatus;
    reason: string;
    recorded_at: string;
  };
  allowed_claims: Claim[];
  disallowed_claims: string[];
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const hasStrings = (value: Record<string, unknown>, keys: string[]) =>
  keys.every((key) => typeof value[key] === "string" && value[key].trim().length > 0);
const isStringOrNull = (value: unknown) => value === null || (typeof value === "string" && value.trim().length > 0);
const dayMs = 24 * 60 * 60 * 1000;
const isDate = (value: unknown) => typeof value === "string" && Number.isFinite(Date.parse(value));
const isNonNegativeInteger = (value: unknown) => Number.isSafeInteger(value) && (value as number) >= 0;
const terminalStatuses: ToolTerminalStatus[] = ["success", "no_result", "unavailable", "timeout", "rate_limited", "invalid_result", "skipped"];
const reviewReasons: ManualReviewReason[] = [
  "missing_required_data",
  "uncertain_identity",
  "duplicate_risk",
  "ambiguous_account",
  "invalid_source_result",
  "source_conflict",
  "unsafe_workflow_state",
  "scoring_unavailable"
];
const isToolStatus = (value: unknown): value is ToolStatus => {
  if (!isRecord(value) || Object.keys(value).length !== requiredToolSteps.length || Object.keys(value).some((step) => !requiredToolSteps.includes(step as RequiredToolStep))) return false;
  return requiredToolSteps.every((step) => {
    const result = value[step];
    return isRecord(result) &&
      terminalStatuses.includes(result.status as ToolTerminalStatus) &&
      isDate(result.completed_at) &&
      (result.detail === undefined || (typeof result.detail === "string" && result.detail.trim().length > 0)) &&
      ((["success", "no_result"] as unknown[]).includes(result.status) || typeof result.detail === "string");
  });
};
const isHttpUrl = (value: unknown) => {
  if (typeof value !== "string") return false;
  try {
    return ["http:", "https:"].includes(new URL(value).protocol);
  } catch {
    return false;
  }
};
const isEvidenceValue = (value: unknown) =>
  typeof value === "boolean" ||
  (typeof value === "number" && Number.isFinite(value)) ||
  (typeof value === "string" && value.trim().length > 0) ||
  (Array.isArray(value) && value.length > 0 && value.every((item) => typeof item === "string" && item.trim().length > 0));
const isFieldValue = (value: unknown) =>
  isEvidenceValue(value) || (Array.isArray(value) && value.every((item) => typeof item === "string" && item.trim().length > 0));
const equalFieldValue = (left: unknown, right: unknown) =>
  Array.isArray(left) && Array.isArray(right)
    ? JSON.stringify([...left].sort()) === JSON.stringify([...right].sort())
    : left === right;
const isEvidence = (value: unknown, sourceTypes: SourceType | SourceType[]) => {
  const allowedTypes = Array.isArray(sourceTypes) ? sourceTypes : [sourceTypes];
  if (!isRecord(value) || !allowedTypes.includes(value.source_type as SourceType) || !hasStrings(value, ["evidence_id", "source_name"]) || !isDate(value.retrieved_at)) return false;
  if (!(["High", "Medium", "Low"] as unknown[]).includes(value.confidence) || typeof value.eligible_for_crm_writeback !== "boolean") return false;
  if (value.source_url !== undefined && !isHttpUrl(value.source_url)) return false;
  if (value.source_record_id !== undefined && (typeof value.source_record_id !== "string" || value.source_record_id.trim().length === 0)) return false;
  if (value.eligible_for_crm_writeback && !hasStrings(value, ["field_name"])) return false;
  if (value.field_values !== undefined && (!isRecord(value.field_values) || Object.keys(value.field_values).length === 0 || !Object.values(value.field_values).every(isFieldValue))) return false;
  const hasField = Object.hasOwn(value, "field_value");
  const hasEvent = Object.hasOwn(value, "event_value");
  if (hasField === hasEvent || !isEvidenceValue(value[hasField ? "field_value" : "event_value"])) return false;
  return value.source_type === "public_signal"
    ? (isHttpUrl(value.source_url) || typeof value.source_record_id === "string") && isDate(value.source_published_at) && value.source_updated_at === undefined
    : isDate(value.source_updated_at);
};
const hasEvidence = (
  value: unknown,
  sourceTypes: SourceType | SourceType[],
  required = false
): value is Record<string, unknown> & { evidence: Evidence[] } =>
  isRecord(value) &&
  Array.isArray(value.evidence) &&
  (!required || value.evidence.length > 0) &&
  value.evidence.every((item) => isEvidence(item, sourceTypes));
const isCrmContext = (value: unknown, accountId: unknown, domain: unknown) => {
  if (!hasEvidence(value, "crm") ||
    ![value.owner, value.source, value.lifecycle_stage, value.routing_status].every(isStringOrNull) ||
    !(["open", "none", "unknown"] as unknown[]).includes(value.open_opportunity_status) ||
    !(["clear", "suspected", "confirmed"] as unknown[]).includes(value.duplicate_status) ||
    !(["verified", "unresolved", "conflicting"] as unknown[]).includes(value.domain_status) ||
    !isRecord(value.company_association)) return false;

  const association = value.company_association;
  if (!(["resolved", "none", "ambiguous"] as unknown[]).includes(association.status) ||
    !(association.basis === null || (["primary", "sole"] as unknown[]).includes(association.basis)) ||
    !Array.isArray(association.candidate_account_ids) ||
    association.candidate_account_ids.some((id) => typeof id !== "string" || id.trim().length === 0) ||
    new Set(association.candidate_account_ids).size !== association.candidate_account_ids.length) return false;

  if (association.status === "resolved") {
    if (typeof accountId !== "string" || accountId.trim().length === 0 || association.basis === null || !association.candidate_account_ids.includes(accountId)) return false;
  } else if (accountId !== null || association.basis !== null) return false;
  if (association.basis === "sole" && association.candidate_account_ids.length !== 1) return false;
  if (association.status === "none" && association.candidate_account_ids.length !== 0) return false;
  if (association.status === "ambiguous" && association.candidate_account_ids.length < 2) return false;
  return value.domain_status === "verified"
    ? typeof domain === "string" && domain.trim().length > 0
    : domain === null;
};
const isPublicSignal = (value: unknown, evaluatedAt: string) => {
  if (!isRecord(value) || !hasStrings(value, ["label", "source"]) || !isNonNegativeInteger(value.days_ago) || !hasEvidence(value, "public_signal", true)) return false;
  const ages = value.evidence.map((item) => Math.floor((Date.parse(evaluatedAt) - Date.parse(item.source_published_at ?? "")) / dayMs));
  return ages.every((age) => age >= 0) &&
    value.days_ago === Math.min(...ages) &&
    value.evidence.some((item, index) =>
      ages[index] === value.days_ago &&
      item.source_name.trim().toLowerCase() === String(value.source).trim().toLowerCase() &&
      item.field_values?.label === value.label
    );
};
const isEnrichmentFields = (value: unknown, evaluatedAt: string) => {
  if (!hasEvidence(value, ["enrichment", "crm"]) || !Array.isArray(value.tech_stack) || !value.tech_stack.every((item) => typeof item === "string" && item.trim().length > 0)) return false;
  if (value.employees !== undefined && !isNonNegativeInteger(value.employees)) return false;
  const supportedFields = ["employees", "revenue_band", "tech_stack"];
  const observed = value.evidence.flatMap((item) => Object.entries(item.field_values ?? {}));
  if (observed.some(([field]) => !supportedFields.includes(field))) return false;
  const populated = supportedFields.filter((field) => value[field] !== undefined && (field !== "tech_stack" || (value.tech_stack as string[]).length > 0));
  if (!populated.every((field) => observed.some(([observedField, observedValue]) => observedField === field && equalFieldValue(observedValue, value[field])))) return false;
  const ages = value.evidence
    .filter((item) => item.source_type === "enrichment")
    .map((item) => Math.floor((Date.parse(evaluatedAt) - Date.parse(item.source_updated_at ?? "")) / dayMs));
  return ages.length === 0
    ? value.last_updated_days_ago === undefined
    : ages.every((age) => age >= 0) && value.last_updated_days_ago === Math.min(...ages);
};
const isIntentSignals = (value: unknown) => {
  const fields = ["surge"];
  if (!hasEvidence(value, "intent") || typeof value.surge !== "boolean") return false;
  const observed = value.evidence.flatMap((item) => Object.entries(item.field_values ?? {}));
  if (observed.some(([field, fieldValue]) => !fields.includes(field) || fieldValue !== value[field])) return false;
  return fields.filter((field) => value[field] !== 0 && value[field] !== false)
    .every((field) => observed.some(([observedField]) => observedField === field));
};
const isEngagementSignals = (value: unknown) => {
  const fields = ["opens", "clicks", "replies", "demo_request", "pricing_page_visit"];
  if (!hasEvidence(value, "engagement") || !fields.slice(0, 3).every((key) => isNonNegativeInteger(value[key])) || !fields.slice(3).every((key) => typeof value[key] === "boolean")) return false;
  const observed = value.evidence.flatMap((item) => Object.entries(item.field_values ?? {}));
  if (observed.some(([field, fieldValue]) => !fields.includes(field) || fieldValue !== value[field])) return false;
  return fields.filter((field) => value[field] !== 0 && value[field] !== false)
    .every((field) => observed.some(([observedField]) => observedField === field));
};
const scoreKeys: Array<keyof ScoreBreakdown> = [
  "icp_fit",
  "high_intent_actions",
  "engagement_quality",
  "public_timing_signals",
  "crm_process_context",
  "data_confidence"
];
const hasValidScore = (value: Record<string, unknown>) => {
  if (!isRecord(value.score_breakdown)) return false;
  const breakdown = value.score_breakdown;
  const actualKeys = Object.keys(breakdown);
  if (actualKeys.length !== scoreKeys.length || actualKeys.some((key) => !scoreKeys.includes(key as keyof ScoreBreakdown))) return false;
  const points = scoreKeys.map((key) => breakdown[key] as number);
  if (points.some((point) => !Number.isFinite(point) || point < 0) || points.reduce((sum, point) => sum + point, 0) > 100) return false;
  const hasItems = (container: unknown) => isRecord(container) && Array.isArray(container.evidence) && container.evidence.length > 0;
  if ((points[0] > 0 && !hasItems(value.enrichment_fields)) ||
    (points[1] > 0 && !hasItems(value.intent_signals) && !hasItems(value.engagement_signals)) ||
    (points[2] > 0 && !hasItems(value.engagement_signals)) ||
    (points[3] > 0 && (!Array.isArray(value.public_signals) || value.public_signals.length === 0)) ||
    (points[4] > 0 && !hasItems(value.crm_context))) return false;
  if (value.priority_band === "Needs Manual Review") return value.priority_score === null && value.confidence === "Low";
  const score = value.priority_score;
  return typeof score === "number" && Number.isFinite(score) && score >= 0 && score <= 100 && score === points.reduce((sum, point) => sum + point, 0);
};

export const assertLeadPacket: (value: unknown) => asserts value is LeadPacket = (value) => {
  if (!isRecord(value) ||
    !hasStrings(value, ["request_id", "evaluation_id", "lead_id", "score_version", "reason", "hook"]) ||
    !(value.account_id === null || (typeof value.account_id === "string" && value.account_id.trim().length > 0)) ||
    !isDate(value.evaluation_timestamp) ||
    !(["Hot", "Warm", "Cold", "Needs Manual Review"] as unknown[]).includes(value.priority_band) ||
    !(["High", "Medium", "Low"] as unknown[]).includes(value.confidence) ||
    !Array.isArray(value.manual_review_reasons) ||
    value.manual_review_reasons.some((reason) => !reviewReasons.includes(reason as ManualReviewReason)) ||
    new Set(value.manual_review_reasons).size !== value.manual_review_reasons.length ||
    !hasValidScore(value) ||
    !isRecord(value.lead_identity) || !hasStrings(value.lead_identity, ["name", "title", "company", "email"]) || !isStringOrNull(value.lead_identity.domain) ||
    !isCrmContext(value.crm_context, value.account_id, value.lead_identity.domain) ||
    !isEnrichmentFields(value.enrichment_fields, String(value.evaluation_timestamp)) ||
    !isIntentSignals(value.intent_signals) ||
    !isEngagementSignals(value.engagement_signals) ||
    !Array.isArray(value.public_signals) || !value.public_signals.every((signal) => isPublicSignal(signal, String(value.evaluation_timestamp))) ||
    !Array.isArray(value.validation_evidence) || !value.validation_evidence.every((item) => isEvidence(item, "validation")) ||
    ![value.missing_fields, value.stale_fields, value.source_conflicts, value.disallowed_claims].every((items) => Array.isArray(items) && items.every((item) => typeof item === "string" && item.trim().length > 0)) ||
    !isToolStatus(value.tool_status) ||
    !(value.writeback_plan === null || (isRecord(value.writeback_plan) && hasStrings(value.writeback_plan, ["reason"]) && (["Eligible", "Review", "Skipped", "Blocked"] as unknown[]).includes(value.writeback_plan.decision))) ||
    !isRecord(value.writeback_outcome) || !hasStrings(value.writeback_outcome, ["reason"]) || !isDate(value.writeback_outcome.recorded_at) || !(["Written", "Skipped", "Flagged for Review", "Blocked", "Data unavailable"] as unknown[]).includes(value.writeback_outcome.status) ||
    !Array.isArray(value.allowed_claims)) {
    throw new Error("Invalid lead packet contract");
  }
  const lead = value as unknown as LeadPacket;
  const isManualReview = lead.priority_band === "Needs Manual Review";
  if ((isManualReview && lead.manual_review_reasons.length === 0) || (!isManualReview && lead.manual_review_reasons.length > 0)) throw new Error("Invalid lead packet contract");
  if (lead.manual_review_reasons.includes("missing_required_data") && lead.missing_fields.length === 0) throw new Error("Invalid lead packet contract");
  if (lead.manual_review_reasons.includes("source_conflict") && lead.source_conflicts.length === 0) throw new Error("Invalid lead packet contract");
  if (lead.crm_context.company_association.status === "ambiguous" && (!isManualReview || !lead.manual_review_reasons.includes("ambiguous_account"))) throw new Error("Invalid lead packet contract");
  if (lead.crm_context.duplicate_status !== "clear" && (!isManualReview || !lead.manual_review_reasons.includes("duplicate_risk"))) throw new Error("Invalid lead packet contract");
  if (lead.crm_context.domain_status !== "verified" && (!isManualReview || !lead.manual_review_reasons.includes("uncertain_identity"))) throw new Error("Invalid lead packet contract");
  if (lead.tool_status.deterministic_score.status !== "success" && (!isManualReview || !lead.manual_review_reasons.includes("scoring_unavailable"))) throw new Error("Invalid lead packet contract");
  if (lead.tool_status.evaluate_crm_writeback.status === "success") {
    if (lead.writeback_plan === null) throw new Error("Invalid lead packet contract");
  } else if (lead.writeback_plan !== null || lead.writeback_outcome.status !== "Data unavailable") throw new Error("Invalid lead packet contract");
  if (isManualReview && lead.writeback_plan?.decision === "Eligible") throw new Error("Invalid lead packet contract");
  if (lead.source_conflicts.length > 0 && lead.writeback_plan?.decision === "Eligible") throw new Error("Invalid lead packet contract");
  if (lead.writeback_outcome.status === "Written" && lead.writeback_plan?.decision !== "Eligible") throw new Error("Invalid lead packet contract");
  if (lead.writeback_outcome.status === "Flagged for Review" && lead.writeback_plan?.decision !== "Review") throw new Error("Invalid lead packet contract");
  if (lead.writeback_outcome.status === "Blocked" && lead.writeback_plan?.decision !== "Blocked") throw new Error("Invalid lead packet contract");

  const emptyCrm = lead.account_id === null && lead.lead_identity.domain === null && lead.crm_context.owner === null && lead.crm_context.source === null && lead.crm_context.lifecycle_stage === null && lead.crm_context.routing_status === null && lead.crm_context.open_opportunity_status === "unknown" && lead.crm_context.company_association.status === "none" && lead.crm_context.duplicate_status === "clear" && lead.crm_context.domain_status === "unresolved" && lead.crm_context.evidence.length === 0;
  const emptyEnrichment = lead.enrichment_fields.evidence.length === 0 && lead.enrichment_fields.employees === undefined && lead.enrichment_fields.revenue_band === undefined && lead.enrichment_fields.tech_stack.length === 0 && lead.enrichment_fields.last_updated_days_ago === undefined;
  const emptySignals = lead.intent_signals.evidence.length === 0 && !lead.intent_signals.surge && lead.engagement_signals.evidence.length === 0 && lead.engagement_signals.opens === 0 && lead.engagement_signals.clicks === 0 && lead.engagement_signals.replies === 0 && !lead.engagement_signals.demo_request && !lead.engagement_signals.pricing_page_visit;
  if (lead.tool_status.get_crm_lead.status !== "success" && !emptyCrm) throw new Error("Invalid lead packet contract");
  if (lead.tool_status.enrich_profile.status !== "success" && !emptyEnrichment) throw new Error("Invalid lead packet contract");
  if (lead.tool_status.fetch_intent_triggers.status !== "success" && !emptySignals) throw new Error("Invalid lead packet contract");
  if (lead.tool_status.fetch_public_signals.status !== "success" && lead.public_signals.length > 0) throw new Error("Invalid lead packet contract");

  const evidence = [
    ...lead.crm_context.evidence,
    ...lead.enrichment_fields.evidence,
    ...lead.intent_signals.evidence,
    ...lead.engagement_signals.evidence,
    ...lead.public_signals.flatMap((signal) => signal.evidence),
    ...lead.validation_evidence
  ];
  const evidenceIds = new Set(evidence.map((item) => item.evidence_id));
  if (evidenceIds.size !== evidence.length || lead.allowed_claims.some((claim) =>
    !isRecord(claim) ||
    !hasStrings(claim, ["text"]) ||
    !Array.isArray(claim.evidence_ids) ||
    claim.evidence_ids.length === 0 ||
    new Set(claim.evidence_ids).size !== claim.evidence_ids.length ||
    claim.evidence_ids.some((id) => typeof id !== "string" || !evidenceIds.has(id))
  )) throw new Error("Invalid lead packet contract");
};

export const scoreLabel = (lead: LeadPacket) =>
  lead.priority_score === null ? "N/A" : `${lead.priority_score}/100`;

export const freshnessLabel = (daysAgo?: number) => {
  if (daysAgo === undefined) return "Data unavailable";
  if (daysAgo > 90) return `Stale (${daysAgo} days old)`;
  return `Fresh (${daysAgo} days old)`;
};

const fallbackHook = "No grounded hook available — no recent verified signal found.";
const normalized = (value: EvidenceValue) => String(value).toLowerCase();
const maxWritebackAgeMs = 90 * dayMs;
const keywords = (value: string) => normalized(value).split(/[^a-z0-9]+/).filter((word) => word.length > 3);
const hasPhrase = (text: string, value: string) => {
  const phrase = normalized(value).replace(/[^a-z0-9]+/g, " ").trim();
  return phrase.length > 0 && ` ${normalized(text).replace(/[^a-z0-9]+/g, " ")} `.includes(` ${phrase} `);
};
const hasTerms = (text: string, value: string) => {
  const terms = keywords(value);
  return terms.length > 0 ? terms.every((word) => normalized(text).includes(word)) : hasPhrase(text, value);
};
const dates = (value: string) => [...value.matchAll(/\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+\d{1,2}(?:st|nd|rd|th)?,?\s+\d{4}\b|\b\d{4}-\d{2}-\d{2}\b/gi)]
  .map((match) => Date.parse(match[0].replace(/(\d)(?:st|nd|rd|th)/i, "$1")))
  .filter(Number.isFinite)
  .map((timestamp) => new Date(timestamp).toISOString().slice(0, 10));

const hasAllowedHookClaim = (lead: LeadPacket, signal: LeadPacket["public_signals"][number], item: Evidence) => {
  const company = normalized(lead.lead_identity.company);
  const evidenceValue = String(item.field_value ?? item.event_value);
  const evidenceDates = dates(evidenceValue);
  return lead.allowed_claims.some((claim) => {
    const text = normalized(claim.text);
    return claim.evidence_ids.includes(item.evidence_id) &&
      hasPhrase(text, company) &&
      hasTerms(text, signal.label) &&
      hasTerms(text, evidenceValue) &&
      evidenceDates.every((date) => dates(text).includes(date));
  });
};

const hasHookEvidence = (lead: LeadPacket) => {
  const hook = normalized(lead.hook);
  if (!hasPhrase(hook, lead.lead_identity.company)) return false;
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

export const hasWritebackEvidence = (lead: LeadPacket, fieldName: string, fieldValue: string) =>
  lead.enrichment_fields.evidence.some((item) =>
    isFreshHighConfidenceWritebackEvidence(item, lead.evaluation_timestamp) &&
    item.field_name === fieldName &&
    normalized(item.field_value ?? item.event_value).trim() === normalized(fieldValue).trim()
  );

export const isWritebackEligible = (lead: LeadPacket) =>
  lead.writeback_plan?.decision === "Eligible" &&
  lead.source_conflicts.length === 0 &&
  lead.enrichment_fields.evidence.some((item) => isFreshHighConfidenceWritebackEvidence(item, lead.evaluation_timestamp));

export const hasOnlyWeakOpenIntent = (lead: LeadPacket) =>
  lead.engagement_signals.opens > 0 &&
  lead.engagement_signals.clicks === 0 &&
  lead.engagement_signals.replies === 0 &&
  !lead.engagement_signals.demo_request &&
  !lead.engagement_signals.pricing_page_visit &&
  !lead.intent_signals.surge;

export const toolRun = [
  ...requiredToolSteps,
  "llm_explanation",
  "write_crm_enrichment"
] as const;
