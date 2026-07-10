import { assertLeadPacket, type Confidence, type Evidence, type LeadPacket } from "./contextai.ts";
import {
  enrichProfile,
  fetchIntentTriggers,
  fetchPublicSignals,
  writeCrmEnrichment,
  type EnrichProfileResult,
  type IntentTriggersResult,
  type PublicSignalsResult,
  type ToolStatus,
} from "./ingestion.ts";
import { applyDeterministicScore, SCORE_VERSION } from "./scoring.ts";

const dayMs = 24 * 60 * 60 * 1000;
const fallbackHook = "No grounded hook available - no recent verified signal found.";

export type CrmLeadSeed = {
  lead_id: string;
  account_id: string;
  name: string;
  title: string;
  company: string;
  email: string;
  domain: string;
  owner: string;
  source: string;
  stage: string;
  evaluation_timestamp?: string;
};

export type ToolRunSummary = {
  enrich_profile: ToolStatus;
  fetch_intent_triggers: ToolStatus;
  fetch_public_signals: ToolStatus;
  write_crm_enrichment: "skipped";
};

const daysBetween = (evaluatedAt: string, sourceDate?: string) => {
  if (!sourceDate) return undefined;
  const age = Math.floor((Date.parse(evaluatedAt) - Date.parse(sourceDate)) / dayMs);
  return Number.isFinite(age) && age >= 0 ? age : undefined;
};

const mergeMissing = (fields: string[]) => [...new Set(fields.filter(Boolean))];

const buildEnrichment = (
  result: EnrichProfileResult,
  evaluatedAt: string,
  leadId: string
): LeadPacket["enrichment_fields"] & { missing: string[]; stale: string[] } => {
  const missing: string[] = [];
  const stale: string[] = [];

  if (result.status !== "success" || result.employees === undefined) {
    missing.push("employees");
  }
  if (result.status !== "success" || !result.revenue_band) {
    missing.push("revenue_band");
  }

  if (result.status !== "success") {
    return { tech_stack: [], evidence: [], missing, stale };
  }

  const last_updated_days_ago = daysBetween(evaluatedAt, result.last_updated);
  if (last_updated_days_ago !== undefined && last_updated_days_ago > 180) {
    stale.push("employees");
  }

  const field_values: Record<string, string | number | boolean | string[]> = {};
  if (result.employees !== undefined) field_values.employees = result.employees;
  if (result.revenue_band) field_values.revenue_band = result.revenue_band;
  if (result.tech_stack.length > 0) field_values.tech_stack = result.tech_stack;

  const evidence: Evidence[] = Object.keys(field_values).length
    ? [
        {
          evidence_id: `${leadId}-enrichment`,
          source_name: result.source_name,
          source_type: "enrichment",
          field_name: result.employees !== undefined ? "numberofemployees" : undefined,
          field_value: result.employees ?? result.revenue_band ?? result.tech_stack,
          field_values,
          source_url: result.source_url,
          retrieved_at: evaluatedAt,
          source_updated_at: result.last_updated ?? evaluatedAt,
          confidence: result.confidence,
          eligible_for_crm_writeback:
            result.confidence === "High" &&
            result.employees !== undefined &&
            (last_updated_days_ago === undefined || last_updated_days_ago <= 90),
        },
      ]
    : [];

  return {
    employees: result.employees,
    revenue_band: result.revenue_band,
    tech_stack: result.tech_stack,
    last_updated_days_ago,
    evidence,
    missing,
    stale,
  };
};

const buildIntent = (
  result: IntentTriggersResult,
  evaluatedAt: string,
  leadId: string
): LeadPacket["intent_signals"] & { missing: boolean } => {
  if (result.status !== "success") {
    return {
      opens: 0,
      clicks: 0,
      replies: 0,
      demo_request: false,
      pricing_page_visit: false,
      surge: false,
      evidence: [],
      missing: true,
    };
  }

  const field_values: Record<string, string | number | boolean | string[]> = {};
  if (result.opens > 0) field_values.opens = result.opens;
  if (result.clicks > 0) field_values.clicks = result.clicks;
  if (result.replies > 0) field_values.replies = result.replies;
  if (result.demo_request) field_values.demo_request = true;
  if (result.pricing_page_visit) field_values.pricing_page_visit = true;
  if (result.surge) field_values.surge = true;

  const hasSignal = Object.keys(field_values).length > 0;
  const summary = [
    result.demo_request ? "Demo request" : null,
    result.pricing_page_visit ? "pricing page visit" : null,
    result.surge ? "category surge" : null,
    result.replies > 0 ? "reply" : null,
    result.opens > 0 ? `${result.opens} email opens` : null,
  ]
    .filter(Boolean)
    .join(", ");

  const evidence: Evidence[] = hasSignal
    ? [
        {
          evidence_id: `${leadId}-intent`,
          source_name: result.source_name,
          source_type: "intent",
          field_value: summary || "Intent signals",
          field_values,
          retrieved_at: evaluatedAt,
          source_updated_at: result.last_updated ?? evaluatedAt,
          confidence: result.confidence,
          eligible_for_crm_writeback: false,
        },
      ]
    : [];

  return {
    opens: result.opens,
    clicks: result.clicks,
    replies: result.replies,
    demo_request: result.demo_request,
    pricing_page_visit: result.pricing_page_visit,
    surge: result.surge,
    evidence,
    missing: !hasSignal,
  };
};

const buildPublic = (
  result: PublicSignalsResult,
  evaluatedAt: string,
  leadId: string
): LeadPacket["public_signals"] => {
  if (result.status !== "success") return [];

  return result.signals.map((signal, index) => {
    const days_ago = daysBetween(evaluatedAt, signal.published_at) ?? 0;
    return {
      label: signal.label,
      source: signal.source,
      days_ago,
      evidence: [
        {
          evidence_id: `${leadId}-public-${index}`,
          source_name: signal.source,
          source_type: "public_signal" as const,
          field_value: `${signal.label} on ${signal.published_at.slice(0, 10)}`,
          field_values: { label: signal.label },
          source_url: signal.source_url,
          retrieved_at: evaluatedAt,
          source_published_at: signal.published_at,
          confidence: signal.confidence,
          eligible_for_crm_writeback: false,
        },
      ],
    };
  });
};

const buildClaims = (
  seed: CrmLeadSeed,
  enrichment: ReturnType<typeof buildEnrichment>,
  intent: ReturnType<typeof buildIntent>,
  publicSignals: LeadPacket["public_signals"]
) => {
  const allowed_claims: LeadPacket["allowed_claims"] = [];
  const company = seed.company;

  if (enrichment.evidence[0] && enrichment.employees !== undefined) {
    allowed_claims.push({
      text: `${enrichment.evidence[0].source_name} reports ${company} has ${enrichment.employees} employees.`,
      evidence_ids: [enrichment.evidence[0].evidence_id],
    });
  }

  if (intent.evidence[0]) {
    allowed_claims.push({
      text: `${intent.evidence[0].source_name} recorded intent activity for ${company}.`,
      evidence_ids: [intent.evidence[0].evidence_id],
    });
  }

  for (const signal of publicSignals) {
    const item = signal.evidence[0];
    if (!item) continue;
    allowed_claims.push({
      text: `${company} — ${signal.label} according to ${signal.source}.`,
      evidence_ids: [item.evidence_id],
    });
  }

  if (allowed_claims.length === 0) {
    allowed_claims.push({
      text: `Required scoring fields are missing for ${company}: employees, revenue band, and intent signals.`,
      evidence_ids: [`${seed.lead_id}-validation-missing`],
    });
  }

  return allowed_claims;
};

const reasonFromSources = (
  enrichment: ReturnType<typeof buildEnrichment>,
  intent: ReturnType<typeof buildIntent>,
  publicSignals: LeadPacket["public_signals"],
  toolStatus: ToolRunSummary
) => {
  if (toolStatus.enrich_profile !== "success" && toolStatus.fetch_intent_triggers !== "success") {
    return "Insufficient firmographic and behavioral data to score.";
  }
  if (enrichment.stale.includes("employees")) {
    return "Fit data is stale; confidence reduced pending refresh.";
  }
  if (intent.demo_request || intent.pricing_page_visit) {
    return "Strong ICP fit plus high-intent engagement from verified intent signals.";
  }
  if (intent.surge) {
    return "Below headcount fit threshold, but strong recent category intent.";
  }
  if (intent.opens > 0 && intent.clicks === 0 && !intent.demo_request) {
    return "ICP fit is positive, but opens alone are not reliable buying intent.";
  }
  if (publicSignals.length > 0) {
    return "Firmographic fit with a recent public timing signal.";
  }
  return "Scored from available CRM, enrichment, and intent sources.";
};

/**
 * PRD tool order after get_crm_lead:
 * enrich_profile → fetch_intent_triggers → fetch_public_signals → deterministic_score
 * write_crm_enrichment remains a read-only stub (no HubSpot PATCH).
 */
export const buildLeadPacketFromSources = async (
  seed: CrmLeadSeed,
  options: { env?: Record<string, string | undefined> } = {}
): Promise<{ lead: LeadPacket; tools: ToolRunSummary }> => {
  const evaluatedAt = seed.evaluation_timestamp ?? new Date().toISOString();
  const env = options.env;

  const [enrichmentResult, intentResult, publicResult] = await Promise.all([
    enrichProfile(seed.domain, { evaluatedAt, env }),
    fetchIntentTriggers(seed.email || seed.lead_id, { evaluatedAt, env }),
    fetchPublicSignals(seed.company, { evaluatedAt, env }),
  ]);

  const writeStub = await writeCrmEnrichment(seed.lead_id);

  const tools: ToolRunSummary = {
    enrich_profile: enrichmentResult.status,
    fetch_intent_triggers: intentResult.status,
    fetch_public_signals: publicResult.status,
    write_crm_enrichment: writeStub.status,
  };

  const enrichment = buildEnrichment(enrichmentResult, evaluatedAt, seed.lead_id);
  const intent = buildIntent(intentResult, evaluatedAt, seed.lead_id);
  const public_signals = buildPublic(publicResult, evaluatedAt, seed.lead_id);

  const missing_fields = mergeMissing([
    ...enrichment.missing,
    ...(intent.missing ? ["intent_signals"] : []),
    ...(public_signals.length === 0 ? ["public_signals"] : []),
  ]);

  const crmEvidenceId = `${seed.lead_id}-crm`;
  const validationId = `${seed.lead_id}-validation-missing`;
  const needsValidation =
    enrichment.employees === undefined && intent.missing;

  const draft: LeadPacket = {
    lead_id: seed.lead_id,
    account_id: seed.account_id,
    evaluation_timestamp: evaluatedAt,
    score_version: SCORE_VERSION,
    priority_score: null,
    priority_band: "Needs Manual Review",
    confidence: "Low" as Confidence,
    reason: reasonFromSources(enrichment, intent, public_signals, tools),
    hook: fallbackHook,
    score_breakdown: {
      icp_fit: 0,
      high_intent_actions: 0,
      engagement_quality: 0,
      public_timing_signals: 0,
      crm_process_context: 0,
      data_confidence: 0,
    },
    lead_identity: {
      name: seed.name,
      title: seed.title || "Data unavailable",
      company: seed.company,
      email: seed.email,
      domain: seed.domain,
    },
    crm_context: {
      owner: seed.owner,
      source: seed.source,
      stage: seed.stage,
      evidence: [
        {
          evidence_id: crmEvidenceId,
          source_name: "HubSpot",
          source_type: "crm",
          field_name: "lifecyclestage",
          field_value: seed.stage,
          field_values: { lifecyclestage: seed.stage, hs_analytics_source: seed.source },
          retrieved_at: evaluatedAt,
          source_updated_at: evaluatedAt,
          confidence: "High",
          eligible_for_crm_writeback: false,
        },
      ],
    },
    enrichment_fields: {
      employees: enrichment.employees,
      revenue_band: enrichment.revenue_band,
      tech_stack: enrichment.tech_stack,
      last_updated_days_ago: enrichment.last_updated_days_ago,
      evidence: enrichment.evidence,
    },
    intent_signals: {
      opens: intent.opens,
      clicks: intent.clicks,
      replies: intent.replies,
      demo_request: intent.demo_request,
      pricing_page_visit: intent.pricing_page_visit,
      surge: intent.surge,
      evidence: intent.evidence,
    },
    public_signals,
    validation_evidence: needsValidation
      ? [
          {
            evidence_id: validationId,
            source_name: "ContextAI validation",
            source_type: "validation",
            field_value: ["employees", "revenue_band", "intent_signals"],
            retrieved_at: evaluatedAt,
            source_updated_at: evaluatedAt,
            confidence: "High",
            eligible_for_crm_writeback: false,
          },
        ]
      : [],
    missing_fields,
    stale_fields: enrichment.stale,
    source_conflicts: [],
    writeback_recommendation: {
      decision: "Skipped",
      reason: writeStub.reason,
    },
    allowed_claims: buildClaims(seed, enrichment, intent, public_signals),
    disallowed_claims: ["Inferred buying intent without verified engagement data."],
  };

  // Score only after tools have populated freshness + confidence evidence.
  const lead = applyDeterministicScore(draft);
  assertLeadPacket(lead);
  return { lead, tools };
};
