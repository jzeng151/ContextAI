import type {
  Band,
  Confidence,
  Evidence,
  LeadPacket,
  ManualReviewReason,
  ScoreBreakdown,
  SourceType,
} from "./contextai.ts";
import type { ScoringRunContext } from "./config.ts";

const categories = [
  "icp_fit",
  "high_intent_actions",
  "engagement_quality",
  "public_timing_signals",
  "crm_process_context",
  "data_confidence",
] as const satisfies readonly (keyof ScoreBreakdown)[];

const v0Points: ScoreBreakdown = {
  icp_fit: 30,
  high_intent_actions: 25,
  engagement_quality: 15,
  public_timing_signals: 15,
  crm_process_context: 10,
  data_confidence: 5,
};

export type ScoreDriver = {
  category: keyof ScoreBreakdown;
  points: number;
  evidence_ids: string[];
};

export type ScoreResult = Pick<
  LeadPacket,
  | "score_version"
  | "priority_score"
  | "priority_band"
  | "confidence"
  | "manual_review_reasons"
  | "score_breakdown"
> & {
  /** All nonzero drivers, highest contribution first. */
  top_drivers: ScoreDriver[];
};

export type ScoredLeadPacket = LeadPacket & { top_drivers: ScoreDriver[] };

type Contribution = { points: number; evidence: Evidence[] };

const dayMs = 24 * 60 * 60 * 1000;
const round = (value: number) => Math.round(value * 100) / 100;
const materiallyBelow = (value: number, limit: number) => limit - value > Number.EPSILON * 100;
const total = (breakdown: ScoreBreakdown) => Object.values(breakdown).reduce((sum, value) => sum + value, 0);
const sameValue = (left: unknown, right: unknown) =>
  Array.isArray(left) && Array.isArray(right)
    ? JSON.stringify([...left].sort()) === JSON.stringify([...right].sort())
    : left === right;
const uniqueEvidence = (evidence: Evidence[]) =>
  [...new Map(evidence.map((item) => [item.evidence_id, item])).values()];
const scaled = (points: number, category: keyof ScoreBreakdown, context: ScoringRunContext) => {
  const cap = context.config.categoryWeights[category];
  return Math.min(cap, round(points / v0Points[category] * cap));
};
const approved = (item: Evidence, context: ScoringRunContext) =>
  context.config.sourcePolicy.approvedSourceTypes.includes(item.source_type);
const ageInDays = (item: Evidence, evaluatedAt: string) => {
  const observedAt = item.source_published_at ?? item.source_updated_at ?? "";
  return Math.floor((Date.parse(evaluatedAt) - Date.parse(observedAt)) / dayMs);
};
const evidenceFor = (
  evidence: Evidence[],
  sourceTypes: SourceType | SourceType[],
  field: string,
  value: unknown,
  lead: LeadPacket,
  context: ScoringRunContext,
  freshThroughDays?: number,
) => {
  const allowed = Array.isArray(sourceTypes) ? sourceTypes : [sourceTypes];
  return evidence.filter((item) => {
    if (!allowed.includes(item.source_type) || !approved(item, context) || !sameValue(item.field_values?.[field], value)) return false;
    if (freshThroughDays === undefined) return true;
    const age = ageInDays(item, lead.evaluation_timestamp);
    return age >= 0 && age <= freshThroughDays;
  });
};
const firmographicEvidenceFor = (lead: LeadPacket, field: string, context: ScoringRunContext) => {
  const observed = lead.enrichment_fields.evidence.filter((item) =>
    ["crm", "enrichment"].includes(item.source_type) &&
    approved(item, context) &&
    Object.hasOwn(item.field_values ?? {}, field) &&
    Number.isFinite(ageInDays(item, lead.evaluation_timestamp)) &&
    ageInDays(item, lead.evaluation_timestamp) >= 0
  );
  const newestBySource = context.config.sourcePolicy.precedence.firmographic.map((source) => {
    const sourceEvidence = observed.filter((item) => item.source_type === source);
    const newestAge = Math.min(...sourceEvidence.map((item) => ageInDays(item, lead.evaluation_timestamp)));
    return sourceEvidence.filter((item) => ageInDays(item, lead.evaluation_timestamp) === newestAge);
  });
  return newestBySource.find((items) => items.some((item) =>
    item.confidence !== "Low" &&
    ageInDays(item, lead.evaluation_timestamp) <= context.config.freshness.firmographic.staleAfterDays
  )) ?? newestBySource.find((items) => items.length > 0) ?? [];
};
const enrichmentEvidenceFor = (lead: LeadPacket, field: string, value: unknown, context: ScoringRunContext) =>
  firmographicEvidenceFor(lead, field, context).filter((item) => sameValue(item.field_values?.[field], value));
const hasFirmographicConflict = (lead: LeadPacket, context: ScoringRunContext) => [
  ["employees", lead.enrichment_fields.employees],
  ["revenue_band", lead.enrichment_fields.revenue_band],
  ["tech_stack", lead.enrichment_fields.tech_stack.length > 0 ? lead.enrichment_fields.tech_stack : undefined],
].some(([field, value]) => value !== undefined && firmographicEvidenceFor(lead, String(field), context)
  .some((item) => !sameValue(item.field_values?.[String(field)], value)));
const signalEvidenceFor = (
  lead: LeadPacket,
  sourceType: "intent" | "engagement",
  field: string,
  value: unknown,
  context: ScoringRunContext,
  fresh = true,
) => evidenceFor(
  sourceType === "intent" ? lead.intent_signals.evidence : lead.engagement_signals.evidence,
  sourceType,
  field,
  value,
  lead,
  context,
  fresh ? context.config.freshness[sourceType].freshThroughDays : undefined,
);

const hasOnlyWeakScoredOpens = (lead: LeadPacket, context: ScoringRunContext) =>
  lead.engagement_signals.opens > 0 &&
  signalEvidenceFor(lead, "engagement", "opens", lead.engagement_signals.opens, context).length > 0 &&
  !(lead.intent_signals.surge && signalEvidenceFor(lead, "intent", "surge", true, context).length > 0) &&
  !(["clicks", "replies"] as const).some((field) =>
    lead.engagement_signals[field] > 0 && signalEvidenceFor(lead, "engagement", field, lead.engagement_signals[field], context).length > 0
  ) &&
  !(["demo_request", "pricing_page_visit"] as const).some((field) =>
    lead.engagement_signals[field] && signalEvidenceFor(lead, "engagement", field, true, context).length > 0
  );

const validEmployees = (lead: LeadPacket, context: ScoringRunContext) =>
  Number.isSafeInteger(lead.enrichment_fields.employees) &&
  Number(lead.enrichment_fields.employees) >= 0 &&
  enrichmentEvidenceFor(lead, "employees", lead.enrichment_fields.employees, context).length > 0;
const hasSupportedEmployees = (lead: LeadPacket, context: ScoringRunContext) =>
  Number.isSafeInteger(lead.enrichment_fields.employees) &&
  Number(lead.enrichment_fields.employees) >= 0 &&
  evidenceFor(lead.enrichment_fields.evidence, ["crm", "enrichment"], "employees", lead.enrichment_fields.employees, lead, context).length > 0;

const hasBehavioralEvidence = (lead: LeadPacket, context: ScoringRunContext) =>
  (lead.intent_signals.surge && signalEvidenceFor(lead, "intent", "surge", true, context).length > 0) ||
  (["clicks", "replies"] as const).some((field) =>
    lead.engagement_signals[field] > 0 && signalEvidenceFor(lead, "engagement", field, lead.engagement_signals[field], context).length > 0
  ) ||
  (["demo_request", "pricing_page_visit"] as const).some((field) =>
    lead.engagement_signals[field] && signalEvidenceFor(lead, "engagement", field, true, context).length > 0
  );

const staleSignalFamilies = (lead: LeadPacket, context: ScoringRunContext) => {
  const stale = (sourceType: "intent" | "engagement", field: string, value: unknown) =>
    signalEvidenceFor(lead, sourceType, field, value, context, false).length > 0 &&
    signalEvidenceFor(lead, sourceType, field, value, context).length === 0;
  const staleIntent = lead.intent_signals.surge && stale("intent", "surge", true);
  const staleEngagement = (["opens", "clicks", "replies"] as const).some((field) =>
      lead.engagement_signals[field] > 0 && stale("engagement", field, lead.engagement_signals[field])
    ) ||
    (["demo_request", "pricing_page_visit"] as const).some((field) =>
      lead.engagement_signals[field] && stale("engagement", field, true)
    );
  const stalePublic = lead.public_signals.some((signal) => {
    const ages = signal.evidence
      .filter((item) => item.source_type === "public_signal" && approved(item, context) && item.source_name.trim().toLowerCase() === signal.source.trim().toLowerCase() && item.field_values?.label === signal.label)
      .map((item) => ageInDays(item, lead.evaluation_timestamp));
    return ages.length > 0 && ages.every((age) => !Number.isFinite(age) || age < 0 || age > context.config.freshness.publicSignal.freshThroughDays);
  });
  return [staleIntent, staleEngagement, stalePublic].filter(Boolean).length;
};

const malformedScoringInput = (lead: LeadPacket) => {
  const employees = lead.enrichment_fields.employees;
  const age = lead.enrichment_fields.last_updated_days_ago;
  const counts = [lead.engagement_signals.opens, lead.engagement_signals.clicks, lead.engagement_signals.replies];
  const evidence = [
    ...lead.crm_context.evidence,
    ...lead.enrichment_fields.evidence,
    ...lead.intent_signals.evidence,
    ...lead.engagement_signals.evidence,
    ...lead.public_signals.flatMap((signal) => signal.evidence),
  ];
  return !Number.isFinite(Date.parse(lead.evaluation_timestamp)) ||
    (employees !== undefined && (!Number.isSafeInteger(employees) || employees < 0)) ||
    (age !== undefined && (!Number.isSafeInteger(age) || age < 0)) ||
    counts.some((value) => !Number.isSafeInteger(value) || value < 0) ||
    lead.public_signals.some((signal) => !Number.isSafeInteger(signal.days_ago) || signal.days_ago < 0) ||
    evidence.some((item) => !Number.isFinite(ageInDays(item, lead.evaluation_timestamp)) || ageInDays(item, lead.evaluation_timestamp) < 0);
};

export const manualReviewReasons = (lead: LeadPacket, context: ScoringRunContext): ManualReviewReason[] => {
  const reasons = new Set<ManualReviewReason>();
  if (lead.manual_review_reasons.includes("unsafe_workflow_state")) reasons.add("unsafe_workflow_state");
  if (lead.source_conflicts.length > 0 || hasFirmographicConflict(lead, context)) reasons.add("source_conflict");
  if (lead.crm_context.domain_status !== "verified") reasons.add("uncertain_identity");
  if (lead.crm_context.duplicate_status !== "clear") reasons.add("duplicate_risk");
  if (lead.crm_context.company_association.status === "ambiguous") reasons.add("ambiguous_account");
  const missingRequiredData = !hasSupportedEmployees(lead, context) && !hasBehavioralEvidence(lead, context);
  if (missingRequiredData) reasons.add("missing_required_data");
  const sourceSteps = ["get_crm_lead", "enrich_profile", "fetch_intent_triggers", "fetch_public_signals"] as const;
  const failedRequiredSource = sourceSteps.some((step) => !["success", "no_result"].includes(lead.tool_status[step].status));
  if (
    malformedScoringInput(lead) ||
    (failedRequiredSource && (missingRequiredData || lead.crm_context.domain_status !== "verified"))
  ) reasons.add("invalid_source_result");
  if (lead.tool_status.deterministic_score.status !== "success") reasons.add("scoring_unavailable");
  return context.config.manualReview.triggers.filter((reason) => reasons.has(reason));
};

export const requiresManualReview = (lead: LeadPacket, context: ScoringRunContext) =>
  manualReviewReasons(lead, context).length > 0;

const scoreIcpFit = (lead: LeadPacket, context: ScoringRunContext): Contribution => {
  if (!validEmployees(lead, context)) return { points: 0, evidence: [] };
  const employees = lead.enrichment_fields.employees as number;
  let points = employees < 20 ? 10 : employees < 50 ? 15 : employees < 100 ? 20 : 25;
  const evidence = enrichmentEvidenceFor(lead, "employees", employees, context);
  const revenue = lead.enrichment_fields.revenue_band
    ? enrichmentEvidenceFor(lead, "revenue_band", lead.enrichment_fields.revenue_band, context)
    : [];
  const tech = lead.enrichment_fields.tech_stack.length > 0
    ? enrichmentEvidenceFor(lead, "tech_stack", lead.enrichment_fields.tech_stack, context)
    : [];
  if (revenue.length > 0 || tech.length > 0) points += 5;
  return { points: scaled(points, "icp_fit", context), evidence: uniqueEvidence([...evidence, ...revenue, ...tech]) };
};

const scoreHighIntentActions = (lead: LeadPacket, context: ScoringRunContext): Contribution => {
  const surge = lead.intent_signals.surge ? signalEvidenceFor(lead, "intent", "surge", true, context) : [];
  const demo = lead.engagement_signals.demo_request ? signalEvidenceFor(lead, "engagement", "demo_request", true, context) : [];
  const pricing = lead.engagement_signals.pricing_page_visit ? signalEvidenceFor(lead, "engagement", "pricing_page_visit", true, context) : [];
  if (surge.length > 0 || demo.length > 0 || pricing.length > 0) {
    return { points: scaled(25, "high_intent_actions", context), evidence: uniqueEvidence([...surge, ...demo, ...pricing]) };
  }
  const replies = lead.engagement_signals.replies > 0
    ? signalEvidenceFor(lead, "engagement", "replies", lead.engagement_signals.replies, context)
    : [];
  if (replies.length > 0) return { points: scaled(15, "high_intent_actions", context), evidence: replies };
  const clicks = lead.engagement_signals.clicks >= 2
    ? signalEvidenceFor(lead, "engagement", "clicks", lead.engagement_signals.clicks, context)
    : [];
  return clicks.length > 0
    ? { points: scaled(10, "high_intent_actions", context), evidence: clicks }
    : { points: 0, evidence: [] };
};

const scoreEngagementQuality = (lead: LeadPacket, context: ScoringRunContext): Contribution => {
  const engagement = lead.engagement_signals;
  const evidence: Evidence[] = [];
  const supported = <K extends keyof typeof engagement>(field: K) => {
    const found = signalEvidenceFor(lead, "engagement", String(field), engagement[field], context);
    if (found.length > 0) evidence.push(...found);
    return found.length > 0;
  };
  const opens = engagement.opens > 0 && supported("opens") ? engagement.opens : 0;
  if (hasOnlyWeakScoredOpens(lead, context)) {
    return { points: scaled(Math.min(opens * 2, 10), "engagement_quality", context), evidence: uniqueEvidence(evidence) };
  }
  const points = Math.max(Math.min(opens * 2, 10),
    (engagement.demo_request && supported("demo_request") ? 5 : 0) +
    (engagement.pricing_page_visit && supported("pricing_page_visit") ? 4 : 0) +
    (engagement.replies > 0 && supported("replies") ? Math.min(engagement.replies, 2) * 3 : 0) +
    (engagement.clicks > 0 && supported("clicks") ? Math.min(engagement.clicks, 3) * 3 : 0) +
    Math.min(opens, 5));
  return { points: scaled(Math.min(points, 15), "engagement_quality", context), evidence: uniqueEvidence(evidence) };
};

const scorePublicTimingSignals = (lead: LeadPacket, context: ScoringRunContext): Contribution => {
  const eligible = lead.public_signals.flatMap((signal) => signal.evidence
    .filter((item) =>
      item.source_type === "public_signal" &&
      approved(item, context) &&
      item.source_name.trim().toLowerCase() === signal.source.trim().toLowerCase() &&
      item.field_values?.label === signal.label
    )
    .map((item) => ({ item, daysAgo: ageInDays(item, lead.evaluation_timestamp) })))
    .filter(({ daysAgo }) => daysAgo >= 0 && daysAgo <= context.config.freshness.publicSignal.freshThroughDays);
  if (eligible.length === 0) return { points: 0, evidence: [] };
  const daysAgo = Math.min(...eligible.map((item) => item.daysAgo));
  const points = daysAgo <= 14 ? 15 : daysAgo <= 30 ? 12 : daysAgo <= 90 ? 8 : 3;
  return {
    points: scaled(points, "public_timing_signals", context),
    evidence: uniqueEvidence(eligible.filter((item) => item.daysAgo === daysAgo).map((item) => item.item)),
  };
};

const isOpenStage = (stage: string | null) => {
  const value = stage?.trim().toLowerCase() ?? "";
  return /^(open|lead|new|active|working)$/.test(value);
};

const scoreCrmProcessContext = (lead: LeadPacket, context: ScoringRunContext): Contribution => {
  const stage = lead.crm_context.routing_status ?? lead.crm_context.lifecycle_stage;
  const normalizedStage = stage?.trim().toLowerCase() ?? "";
  const normalizedSource = lead.crm_context.source?.trim().toLowerCase() ?? "";
  const evidence = lead.crm_context.evidence.filter((item) => {
    if (item.source_type !== "crm" || !approved(item, context)) return false;
    const observedStage = item.field_values?.routing_status ?? item.field_values?.lifecycle_stage ?? item.field_value ?? item.event_value;
    const observedSource = item.field_values?.source;
    return typeof observedStage === "string" && observedStage.trim().toLowerCase() === normalizedStage &&
      typeof observedSource === "string" && observedSource.trim().toLowerCase() === normalizedSource;
  });
  if (evidence.length === 0 || !isOpenStage(stage)) {
    return { points: 0, evidence: [] };
  }
  const source = normalizedSource;
  const points = /intent|surge/.test(source) ? 10 : /sequence/.test(source) ? 9 : /outbound/.test(source) ? 8 : 5;
  return { points: scaled(points, "crm_process_context", context), evidence };
};

const scoreDataConfidence = (lead: LeadPacket, context: ScoringRunContext): Contribution => {
  if (!validEmployees(lead, context)) return { points: 0, evidence: [] };
  const evidence = enrichmentEvidenceFor(lead, "employees", lead.enrichment_fields.employees, context);
  const age = Math.min(...evidence.map((item) => ageInDays(item, lead.evaluation_timestamp)));
  if (evidence.some((item) => item.confidence === "Low") || age > context.config.freshness.firmographic.staleAfterDays) {
    return { points: 0, evidence: [] };
  }
  const points = age > context.config.freshness.firmographic.freshThroughDays || lead.stale_fields.length > 0 ? 2 : 5;
  return { points: scaled(points, "data_confidence", context), evidence };
};

export const bandForScore = (score: number, context: ScoringRunContext): Band => {
  if (score >= context.config.bandThresholds.Hot) return "Hot";
  if (score >= context.config.bandThresholds.Warm) return "Warm";
  return "Cold";
};

const confidenceForLead = (
  lead: LeadPacket,
  breakdown: ScoreBreakdown,
  drivers: ScoreDriver[],
  evidence: Evidence[],
  context: ScoringRunContext,
): Confidence => {
  if (!validEmployees(lead, context)) return "Low";
  const employeeEvidence = enrichmentEvidenceFor(lead, "employees", lead.enrichment_fields.employees, context);
  const age = Math.min(...employeeEvidence.map((item) => ageInDays(item, lead.evaluation_timestamp)));
  const staleSources = staleSignalFamilies(lead, context);
  if (
    age > context.config.freshness.firmographic.staleAfterDays ||
    lead.stale_fields.includes("employees") ||
    lead.stale_fields.length > context.config.confidenceRules.medium.maxNonKeyStaleSources ||
    staleSources > context.config.confidenceRules.medium.maxNonKeyStaleSources
  ) return "Low";
  const usedIds = new Set(drivers.flatMap((driver) => driver.evidence_ids));
  const usedConfidence = evidence.filter((item) => usedIds.has(item.evidence_id)).map((item) => item.confidence);
  if (usedConfidence.includes("Low")) return "Low";
  if (
    usedConfidence.includes("Medium") ||
    hasOnlyWeakScoredOpens(lead, context) ||
    staleSources > 0 ||
    (breakdown.high_intent_actions === 0 && breakdown.engagement_quality === 0) ||
    lead.missing_fields.includes("revenue_band") ||
    lead.stale_fields.length > 0 ||
    age > context.config.freshness.firmographic.freshThroughDays ||
    materiallyBelow(breakdown.data_confidence, context.config.categoryWeights.data_confidence)
  ) return "Medium";
  return "High";
};

/** Pure deterministic scoring. LLM and telemetry code must consume, never replace, this result. */
export const scoreLead = (lead: LeadPacket, context: ScoringRunContext): ScoreResult => {
  const manual_review_reasons = manualReviewReasons(lead, context);
  if (manual_review_reasons.length > 0) {
    return {
      score_version: context.score_version,
      priority_score: context.config.manualReview.priorityScore,
      priority_band: context.config.manualReview.priorityBand,
      confidence: context.config.manualReview.confidence,
      manual_review_reasons,
      score_breakdown: Object.fromEntries(categories.map((category) => [category, 0])) as ScoreBreakdown,
      top_drivers: [],
    };
  }

  const contributions: Record<keyof ScoreBreakdown, Contribution> = {
    icp_fit: scoreIcpFit(lead, context),
    high_intent_actions: scoreHighIntentActions(lead, context),
    engagement_quality: scoreEngagementQuality(lead, context),
    public_timing_signals: scorePublicTimingSignals(lead, context),
    crm_process_context: scoreCrmProcessContext(lead, context),
    data_confidence: scoreDataConfidence(lead, context),
  };
  const score_breakdown = Object.fromEntries(categories.map((category) => [category, contributions[category].points])) as ScoreBreakdown;

  let priority_score = total(score_breakdown);
  if (!context.config.weakSignals.emailOpens.canProduceHotAlone && hasOnlyWeakScoredOpens(lead, context)) {
    const withoutOpens = priority_score - score_breakdown.engagement_quality;
    if (bandForScore(priority_score, context) === "Hot" && withoutOpens < context.config.bandThresholds.Hot) {
      contributions.engagement_quality = { points: 0, evidence: [] };
      score_breakdown.engagement_quality = 0;
      priority_score = total(score_breakdown);
    }
  }
  if (priority_score > 100) {
    const category = [...categories].reverse().find((key) => score_breakdown[key] > 0);
    if (category) {
      const index = categories.indexOf(category);
      const prefix = categories.slice(0, index).reduce((sum, key) => sum + score_breakdown[key], 0);
      contributions[category].points = Math.max(0, 100 - prefix);
      score_breakdown[category] = contributions[category].points;
      priority_score = total(score_breakdown);
    }
  }
  const top_drivers = categories
    .filter((category) => score_breakdown[category] > 0)
    .map((category) => ({
      category,
      points: score_breakdown[category],
      evidence_ids: uniqueEvidence(contributions[category].evidence).map((item) => item.evidence_id),
    }))
    .sort((left, right) => right.points - left.points || categories.indexOf(left.category) - categories.indexOf(right.category));
  const evidence = uniqueEvidence(categories.flatMap((category) => contributions[category].evidence));

  return {
    score_version: context.score_version,
    priority_score,
    priority_band: bandForScore(priority_score, context),
    confidence: confidenceForLead(lead, score_breakdown, top_drivers, evidence, context),
    manual_review_reasons: [],
    score_breakdown,
    top_drivers,
  };
};

export const applyDeterministicScore = (lead: LeadPacket, context: ScoringRunContext): ScoredLeadPacket => {
  const scored = scoreLead(lead, context);
  if (scored.priority_band === "Needs Manual Review" && lead.writeback_outcome.status === "Written") {
    throw new Error("Cannot rescore a packet for manual review after CRM writeback");
  }
  return {
    ...lead,
    ...scored,
    ...(scored.priority_band === "Needs Manual Review" && lead.writeback_plan?.decision === "Eligible"
      ? { writeback_plan: { decision: "Review" as const, reason: "Manual review is required before CRM writeback." } }
      : {}),
    ...(lead.source_conflicts.length === 0 && hasFirmographicConflict(lead, context)
      ? { source_conflicts: ["Authoritative CRM firmographic evidence conflicts with the selected value."] }
      : {}),
    ...(scored.manual_review_reasons.includes("missing_required_data") && !lead.missing_fields.includes("employees")
      ? { missing_fields: [...lead.missing_fields, "employees"] }
      : {}),
  };
};
