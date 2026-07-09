export type Band = "Hot" | "Warm" | "Low Warm" | "Cold" | "Needs Manual Review";
export type Confidence = "High" | "Medium" | "Medium-Low" | "Low";

export type LeadPacket = {
  id: string;
  name: string;
  title: string;
  company: string;
  email: string;
  domain: string;
  owner: string;
  source: string;
  stage: string;
  score: number | null;
  band: Band;
  confidence: Confidence;
  reason: string;
  hook: string;
  missingOrStale?: string;
  enrichment: {
    employees?: number;
    revenueBand?: string;
    techStack: string[];
    lastUpdatedDaysAgo?: number;
  };
  intent: {
    opens: number;
    clicks: number;
    replies: number;
    demoRequest: boolean;
    pricingPageVisit: boolean;
    surge: boolean;
  };
  publicSignal?: {
    label: string;
    source: string;
    daysAgo: number;
  };
  scoreBreakdown: {
    fit: number;
    intent: number;
    engagement: number;
    publicSignal: number;
  };
  writeback: {
    decision: "Eligible" | "Review" | "Skipped";
    reason: string;
  };
};

export const scoreLabel = (lead: LeadPacket) => lead.score === null ? "N/A" : `${lead.score}/100`;

export const freshnessLabel = (daysAgo?: number) => {
  if (daysAgo === undefined) return "Data unavailable";
  if (daysAgo > 90) return `Stale (${daysAgo} days old)`;
  return `Fresh (${daysAgo} days old)`;
};

export const groundedHook = (lead: LeadPacket) =>
  lead.publicSignal || lead.intent.demoRequest || lead.intent.pricingPageVisit
    ? lead.hook
    : "No grounded hook available - no recent verified signal found.";

export const isWritebackEligible = (lead: LeadPacket) =>
  lead.writeback.decision === "Eligible" && (lead.enrichment.lastUpdatedDaysAgo ?? Infinity) <= 90;

export const hasOnlyWeakOpenIntent = (lead: LeadPacket) =>
  lead.intent.opens > 0 &&
  lead.intent.clicks === 0 &&
  lead.intent.replies === 0 &&
  !lead.intent.demoRequest &&
  !lead.intent.pricingPageVisit &&
  !lead.intent.surge;

export const toolRun = [
  "get_crm_lead",
  "enrich_profile",
  "fetch_intent_triggers",
  "fetch_public_signals",
  "deterministic_score",
  "llm_explanation",
  "write_crm_enrichment"
] as const;
