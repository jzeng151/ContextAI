import type { Band, Confidence, LeadPacket, ScoreBreakdown } from "./contextai.ts";
import { hasOnlyWeakOpenIntent, scoreCaps } from "./contextai.ts";

export const SCORE_VERSION = "score-v0.1";

export const SCORE_CAPS = scoreCaps;

export const BAND_THRESHOLDS = {
  hot: 80,
  warm: 60,
} as const;

export type ScoreResult = {
  score_version: string;
  priority_score: number | null;
  priority_band: Band;
  confidence: Confidence;
  score_breakdown: ScoreBreakdown;
};

const clamp = (value: number, max: number) => Math.max(0, Math.min(max, value));

const hasEmployees = (lead: LeadPacket) =>
  typeof lead.enrichment_fields.employees === "number";

const hasAnyIntentEvidence = (lead: LeadPacket) => {
  const intent = lead.intent_signals;
  return (
    intent.evidence.length > 0 ||
    intent.opens > 0 ||
    intent.clicks > 0 ||
    intent.replies > 0 ||
    intent.demo_request ||
    intent.pricing_page_visit ||
    intent.surge
  );
};

const isOpenStage = (stage: string) => {
  const value = stage.trim().toLowerCase();
  return value.length > 0 && !/need|research|unknown|n\/a/.test(value);
};

/** Required firmographics + behavioral signal missing, or unresolved source conflict. */
export const requiresManualReview = (lead: LeadPacket) => {
  if (lead.source_conflicts.length > 0) return true;
  if (!hasEmployees(lead) && !hasAnyIntentEvidence(lead)) return true;
  return false;
};

const scoreIcpFit = (lead: LeadPacket) => {
  const employees = lead.enrichment_fields.employees;
  if (employees === undefined) return 0;

  let points = 0;
  if (employees < 20) points = 10;
  else if (employees < 50) points = 15;
  else if (employees < 100) points = 20;
  else points = 25;

  const hasFirmographicDepth =
    Boolean(lead.enrichment_fields.revenue_band) || lead.enrichment_fields.tech_stack.length > 0;
  if (hasFirmographicDepth) points += 5;

  return clamp(points, SCORE_CAPS.icp_fit);
};

const scoreHighIntentActions = (lead: LeadPacket) => {
  const intent = lead.intent_signals;
  if (intent.demo_request || intent.pricing_page_visit || intent.surge) {
    return SCORE_CAPS.high_intent_actions;
  }
  if (intent.replies > 0) return 15;
  if (intent.clicks >= 2) return 10;
  return 0;
};

const scoreEngagementQuality = (lead: LeadPacket) => {
  const intent = lead.intent_signals;
  if (hasOnlyWeakOpenIntent(lead)) {
    return clamp(intent.opens * 2, 10);
  }

  let points = 0;
  if (intent.demo_request) points += 5;
  if (intent.pricing_page_visit) points += 4;
  points += Math.min(intent.replies, 2) * 3;
  points += Math.min(intent.clicks, 3) * 3;
  points += Math.min(intent.opens, 5);
  return clamp(points, SCORE_CAPS.engagement_quality);
};

const scorePublicTimingSignals = (lead: LeadPacket) => {
  if (lead.public_signals.length === 0) return 0;
  const daysAgo = Math.min(...lead.public_signals.map((signal) => signal.days_ago));
  if (daysAgo <= 14) return 15;
  if (daysAgo <= 30) return 12;
  if (daysAgo <= 90) return 8;
  return 3;
};

const scoreCrmProcessContext = (lead: LeadPacket) => {
  const source = lead.crm_context.source.toLowerCase();
  if (!isOpenStage(lead.crm_context.stage)) return 0;
  if (/intent|surge/.test(source)) return 10;
  if (/sequence/.test(source)) return 9;
  if (/outbound/.test(source)) return 8;
  if (/inbound|demo/.test(source)) return 5;
  if (/list|import/.test(source)) return 5;
  return 5;
};

const scoreDataConfidence = (lead: LeadPacket) => {
  if (lead.source_conflicts.length > 0) return 0;
  if (!hasEmployees(lead)) return 0;

  const age = lead.enrichment_fields.last_updated_days_ago;
  if (age !== undefined && age > 180) return 0;
  if (age !== undefined && age > 90) return 2;
  if (lead.stale_fields.length > 0) return 2;
  return SCORE_CAPS.data_confidence;
};

const bandForScore = (score: number): Band => {
  if (score >= BAND_THRESHOLDS.hot) return "Hot";
  if (score >= BAND_THRESHOLDS.warm) return "Warm";
  return "Cold";
};

const confidenceForLead = (lead: LeadPacket, breakdown: ScoreBreakdown, band: Band): Confidence => {
  if (band === "Needs Manual Review" || lead.source_conflicts.length > 0) return "Low";
  if (!hasEmployees(lead)) return "Low";

  const enrichmentAge = lead.enrichment_fields.last_updated_days_ago;
  if (enrichmentAge !== undefined && enrichmentAge > 180) return "Low";
  if (lead.stale_fields.length > 0) return "Low";

  const enrichmentConfidence = lead.enrichment_fields.evidence.map((item) => item.confidence);
  if (enrichmentConfidence.includes("Low")) return "Low";

  if (
    hasOnlyWeakOpenIntent(lead) ||
    lead.missing_fields.includes("revenue_band") ||
    enrichmentConfidence.includes("Medium") ||
    (enrichmentAge !== undefined && enrichmentAge > 90)
  ) {
    return "Medium";
  }

  if (breakdown.data_confidence < SCORE_CAPS.data_confidence) return "Medium";
  return "High";
};

/**
 * Deterministic 0–100 priority score. The LLM must never call or replace this.
 * Email opens alone cannot produce Hot. Conflicts / missing required data → Needs Manual Review.
 */
export const scoreLead = (lead: LeadPacket): ScoreResult => {
  if (requiresManualReview(lead)) {
    return {
      score_version: SCORE_VERSION,
      priority_score: null,
      priority_band: "Needs Manual Review",
      confidence: "Low",
      score_breakdown: {
        icp_fit: 0,
        high_intent_actions: 0,
        engagement_quality: 0,
        public_timing_signals: 0,
        crm_process_context: lead.source_conflicts.length > 0 ? scoreCrmProcessContext(lead) : 0,
        data_confidence: 0,
      },
    };
  }

  let score_breakdown: ScoreBreakdown = {
    icp_fit: scoreIcpFit(lead),
    high_intent_actions: scoreHighIntentActions(lead),
    engagement_quality: scoreEngagementQuality(lead),
    public_timing_signals: scorePublicTimingSignals(lead),
    crm_process_context: scoreCrmProcessContext(lead),
    data_confidence: scoreDataConfidence(lead),
  };

  let priority_score = Object.values(score_breakdown).reduce((sum, value) => sum + value, 0);
  let priority_band = bandForScore(priority_score);

  // Safeguard: opens-only intent must never classify as Hot.
  if (hasOnlyWeakOpenIntent(lead) && priority_band === "Hot") {
    score_breakdown = {
      ...score_breakdown,
      high_intent_actions: 0,
      engagement_quality: clamp(lead.intent_signals.opens * 2, 10),
    };
    priority_score = Object.values(score_breakdown).reduce((sum, value) => sum + value, 0);
    priority_band = bandForScore(priority_score);
    if (priority_band === "Hot") {
      priority_score = BAND_THRESHOLDS.hot - 1;
      priority_band = "Warm";
    }
  }

  return {
    score_version: SCORE_VERSION,
    priority_score,
    priority_band,
    confidence: confidenceForLead(lead, score_breakdown, priority_band),
    score_breakdown,
  };
};

export const applyDeterministicScore = (lead: LeadPacket): LeadPacket => {
  const scored = scoreLead(lead);
  return {
    ...lead,
    score_version: scored.score_version,
    priority_score: scored.priority_score,
    priority_band: scored.priority_band,
    confidence: scored.confidence,
    score_breakdown: scored.score_breakdown,
  };
};
