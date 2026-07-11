import type { Confidence, Evidence, LeadPacket, SourceType, ToolStatus } from "../lib/contextai";
import { createScoringRunContext, defaultConfigVersion } from "../lib/config.ts";

const evaluatedAt = "2026-07-09T09:00:00.000Z";
const scoreVersion = createScoringRunContext(defaultConfigVersion).score_version;
const requestId = "request-morning-2026-07-09";

const toolStatus = (overrides: Partial<ToolStatus> = {}): ToolStatus => ({
  get_crm_lead: { status: "success", completed_at: evaluatedAt },
  enrich_profile: { status: "success", completed_at: evaluatedAt },
  fetch_intent_triggers: { status: "success", completed_at: evaluatedAt },
  fetch_public_signals: { status: "success", completed_at: evaluatedAt },
  deterministic_score: { status: "success", completed_at: evaluatedAt },
  evaluate_crm_writeback: { status: "success", completed_at: evaluatedAt },
  ...overrides
});

const evidence = (
  evidence_id: string,
  source_name: string,
  source_type: SourceType,
  confidence: Confidence,
  value: string | number | boolean | string[],
  daysAgo: number,
  eligible_for_crm_writeback = false,
  source_url?: string,
  field_name?: string,
  field_values?: Record<string, string | number | boolean | string[]>
): Evidence => {
  const sourceDate = new Date(Date.parse(evaluatedAt) - daysAgo * 24 * 60 * 60 * 1000).toISOString();
  return {
    evidence_id,
    source_name,
    source_type,
    field_name,
    field_values,
    source_url,
    retrieved_at: evaluatedAt,
    ...(source_type === "public_signal" ? { source_published_at: sourceDate } : { source_updated_at: sourceDate }),
    confidence,
    field_value: value,
    eligible_for_crm_writeback
  };
};

export const leads: LeadPacket[] = [
  {
    request_id: requestId,
    evaluation_id: "eval-golden-normal",
    lead_id: "golden-normal",
    account_id: "acct-enterprisecorp",
    evaluation_timestamp: evaluatedAt,
    score_version: scoreVersion,
    lead_identity: {
      name: "John Smith",
      title: "Director of IT",
      company: "EnterpriseCorp",
      email: "john.smith@enterprisecorp.com",
      domain: "enterprisecorp.com"
    },
    crm_context: {
      owner: "Maya Chen",
      source: "Inbound demo",
      lifecycle_stage: "lead",
      routing_status: "open",
      open_opportunity_status: "none",
      company_association: { status: "resolved", basis: "primary", candidate_account_ids: ["acct-enterprisecorp"] },
      duplicate_status: "clear",
      domain_status: "verified",
      evidence: [evidence("gn-crm-stage", "HubSpot", "crm", "High", "Open", 0)]
    },
    priority_score: 94,
    priority_band: "Hot",
    confidence: "High",
    manual_review_reasons: [],
    reason: "Strong ICP fit plus demo-request and pricing-page intent.",
    hook: "Reference EnterpriseCorp's Series B funding announced on July 1, 2026.",
    enrichment_fields: {
      employees: 500,
      revenue_band: "$50M-$100M",
      tech_stack: ["Salesforce"],
      last_updated_days_ago: 18,
      evidence: [evidence("gn-enrichment", "Clearbit", "enrichment", "High", 500, 18, true, undefined, "numberofemployees", { employees: 500, revenue_band: "$50M-$100M", tech_stack: ["Salesforce"] })]
    },
    intent_signals: {
      surge: false,
      evidence: []
    },
    engagement_signals: {
      opens: 2,
      clicks: 1,
      replies: 0,
      demo_request: true,
      pricing_page_visit: true,
      evidence: [evidence("gn-intent", "HubSpot", "engagement", "High", "Demo request and pricing page visit", 1, false, undefined, undefined, { opens: 2, clicks: 1, demo_request: true, pricing_page_visit: true })]
    },
    public_signals: [{
      label: "Series B funding announced",
      source: "Crunchbase",
      days_ago: 8,
      evidence: [evidence("gn-public-series-b", "Crunchbase", "public_signal", "High", "Series B funding announced on July 1, 2026", 8, false, "https://example.com/enterprisecorp-series-b", undefined, { label: "Series B funding announced" })]
    }],
    score_breakdown: {
      icp_fit: 30,
      high_intent_actions: 25,
      engagement_quality: 14,
      public_timing_signals: 15,
      crm_process_context: 5,
      data_confidence: 5
    },
    validation_evidence: [],
    missing_fields: [],
    stale_fields: [],
    source_conflicts: [],
    tool_status: toolStatus(),
    writeback_plan: { decision: "Eligible", reason: "Verified enrichment is fresh and source-backed." },
    writeback_outcome: { status: "Skipped", reason: "Live CRM writeback is disabled for fixture evaluations.", recorded_at: evaluatedAt },
    allowed_claims: [
      { text: "Clearbit reports EnterpriseCorp has 500 employees.", evidence_ids: ["gn-enrichment"] },
      { text: "HubSpot recorded a demo request and pricing-page visit for EnterpriseCorp.", evidence_ids: ["gn-intent"] },
      { text: "EnterpriseCorp announced a Series B funding round on July 1, 2026, according to Crunchbase.", evidence_ids: ["gn-public-series-b"] }
    ],
    disallowed_claims: ["EnterpriseCorp is likely investing in sales automation after its Series B."]
  },
  {
    request_id: requestId,
    evaluation_id: "eval-small-high-intent",
    lead_id: "small-high-intent",
    account_id: "acct-leantech",
    evaluation_timestamp: evaluatedAt,
    score_version: scoreVersion,
    lead_identity: {
      name: "Alice Green",
      title: "Ops Manager",
      company: "LeanTech",
      email: "alice@leantech.io",
      domain: "leantech.io"
    },
    crm_context: {
      owner: "Sam Rivera",
      source: "Intent surge",
      lifecycle_stage: "lead",
      routing_status: "open",
      open_opportunity_status: "none",
      company_association: { status: "resolved", basis: "sole", candidate_account_ids: ["acct-leantech"] },
      duplicate_status: "clear",
      domain_status: "verified",
      evidence: [evidence("shi-crm-stage", "HubSpot", "crm", "High", "Open", 0)]
    },
    priority_score: 50,
    priority_band: "Cold",
    confidence: "Medium",
    manual_review_reasons: [],
    reason: "Below headcount fit threshold, but strong recent category intent.",
    hook: "No grounded hook available — no recent verified signal found.",
    enrichment_fields: {
      employees: 12,
      tech_stack: [],
      last_updated_days_ago: 22,
      evidence: [evidence("shi-enrichment", "Apollo", "enrichment", "Medium", 12, 22, false, undefined, undefined, { employees: 12 })]
    },
    intent_signals: {
      surge: true,
      evidence: [evidence("shi-intent", "Bombora", "intent", "Medium", "Category surge", 2, false, undefined, undefined, { surge: true })]
    },
    engagement_signals: {
      opens: 0,
      clicks: 0,
      replies: 0,
      demo_request: false,
      pricing_page_visit: false,
      evidence: []
    },
    public_signals: [],
    score_breakdown: {
      icp_fit: 10,
      high_intent_actions: 25,
      engagement_quality: 0,
      public_timing_signals: 0,
      crm_process_context: 10,
      data_confidence: 5
    },
    validation_evidence: [],
    missing_fields: ["revenue_band", "public_signals"],
    stale_fields: [],
    source_conflicts: [],
    tool_status: toolStatus({ fetch_public_signals: { status: "no_result", completed_at: evaluatedAt, detail: "No verified public signals found." } }),
    writeback_plan: { decision: "Review", reason: "Company size is verified, but account is below fit threshold." },
    writeback_outcome: { status: "Flagged for Review", reason: "The deterministic plan requires review.", recorded_at: evaluatedAt },
    allowed_claims: [
      { text: "Apollo reports LeanTech has 12 employees.", evidence_ids: ["shi-enrichment"] },
      { text: "Bombora reported a category surge for LeanTech 2 days before evaluation.", evidence_ids: ["shi-intent"] }
    ],
    disallowed_claims: ["LeanTech is ready to buy because category intent increased."]
  },
  {
    request_id: requestId,
    evaluation_id: "eval-no-usable-data",
    lead_id: "no-usable-data",
    account_id: null,
    evaluation_timestamp: evaluatedAt,
    score_version: scoreVersion,
    lead_identity: {
      name: "Unknown User",
      title: "Data unavailable",
      company: "test-error.com",
      email: "unknown@test-error.com",
      domain: null
    },
    crm_context: {
      owner: "Maya Chen",
      source: "Reassigned lead",
      lifecycle_stage: "lead",
      routing_status: "needs_research",
      open_opportunity_status: "unknown",
      company_association: { status: "none", basis: null, candidate_account_ids: [] },
      duplicate_status: "clear",
      domain_status: "unresolved",
      evidence: [evidence("nud-crm-stage", "HubSpot", "crm", "Medium", "Needs research", 0)]
    },
    priority_score: null,
    priority_band: "Needs Manual Review",
    confidence: "Low",
    manual_review_reasons: ["missing_required_data", "uncertain_identity", "invalid_source_result"],
    reason: "Insufficient firmographic and behavioral data to score.",
    hook: "No grounded hook available — no recent verified signal found.",
    enrichment_fields: { tech_stack: [], evidence: [] },
    intent_signals: {
      surge: false,
      evidence: []
    },
    engagement_signals: {
      opens: 0,
      clicks: 0,
      replies: 0,
      demo_request: false,
      pricing_page_visit: false,
      evidence: []
    },
    public_signals: [],
    score_breakdown: {
      icp_fit: 0,
      high_intent_actions: 0,
      engagement_quality: 0,
      public_timing_signals: 0,
      crm_process_context: 0,
      data_confidence: 0
    },
    validation_evidence: [evidence("nud-validation-missing", "ContextAI validation", "validation", "High", ["employees", "revenue_band", "intent_signals"], 0)],
    missing_fields: ["account_id", "corporate_domain", "employees", "revenue_band", "intent_signals"],
    stale_fields: [],
    source_conflicts: [],
    tool_status: toolStatus({
      enrich_profile: { status: "unavailable", completed_at: evaluatedAt, detail: "Profile enrichment returned no usable provider result." },
      fetch_intent_triggers: { status: "timeout", completed_at: evaluatedAt, detail: "Intent and engagement retrieval timed out." },
      fetch_public_signals: { status: "no_result", completed_at: evaluatedAt, detail: "No verified public signals found." }
    }),
    writeback_plan: { decision: "Skipped", reason: "No schema-valid enrichment available." },
    writeback_outcome: { status: "Skipped", reason: "The deterministic plan contains no write.", recorded_at: evaluatedAt },
    allowed_claims: [{ text: "Required scoring fields are missing for test-error.com: employees, revenue band, and intent signals.", evidence_ids: ["nud-validation-missing"] }],
    disallowed_claims: ["The lead has enough verified context for outreach."]
  },
  {
    request_id: requestId,
    evaluation_id: "eval-no-public-signal",
    lead_id: "no-public-signal",
    account_id: "acct-scalegrid",
    evaluation_timestamp: evaluatedAt,
    score_version: scoreVersion,
    lead_identity: {
      name: "Priya Nair",
      title: "VP Revenue",
      company: "ScaleGrid",
      email: "priya@scalegrid.example",
      domain: "scalegrid.example"
    },
    crm_context: {
      owner: "Jordan Lee",
      source: "Outbound assist",
      lifecycle_stage: "lead",
      routing_status: "open",
      open_opportunity_status: "none",
      company_association: { status: "resolved", basis: "primary", candidate_account_ids: ["acct-scalegrid"] },
      duplicate_status: "clear",
      domain_status: "verified",
      evidence: [evidence("nps-crm-stage", "HubSpot", "crm", "High", "Open", 0)]
    },
    priority_score: 83,
    priority_band: "Hot",
    confidence: "High",
    manual_review_reasons: [],
    reason: "Strong fit and high engagement from verified intent signals.",
    hook: "No grounded hook available — no recent verified signal found.",
    enrichment_fields: {
      employees: 900,
      revenue_band: "$100M-$250M",
      tech_stack: ["HubSpot", "Salesforce"],
      last_updated_days_ago: 31,
      evidence: [evidence("nps-enrichment", "ZoomInfo", "enrichment", "High", 900, 31, true, undefined, "numberofemployees", { employees: 900, revenue_band: "$100M-$250M", tech_stack: ["HubSpot", "Salesforce"] })]
    },
    intent_signals: {
      surge: false,
      evidence: []
    },
    engagement_signals: {
      opens: 1,
      clicks: 2,
      replies: 1,
      demo_request: true,
      pricing_page_visit: true,
      evidence: [evidence("nps-intent", "HubSpot", "engagement", "High", "Demo request, pricing page visit, and reply", 3, false, undefined, undefined, { opens: 1, clicks: 2, replies: 1, demo_request: true, pricing_page_visit: true })]
    },
    public_signals: [],
    score_breakdown: {
      icp_fit: 30,
      high_intent_actions: 25,
      engagement_quality: 15,
      public_timing_signals: 0,
      crm_process_context: 8,
      data_confidence: 5
    },
    validation_evidence: [],
    missing_fields: ["public_signals"],
    stale_fields: [],
    source_conflicts: [],
    tool_status: toolStatus({ fetch_public_signals: { status: "no_result", completed_at: evaluatedAt, detail: "No verified public signals found." } }),
    writeback_plan: { decision: "Eligible", reason: "Firmographic fields are fresh and verified." },
    writeback_outcome: { status: "Skipped", reason: "Live CRM writeback is disabled for fixture evaluations.", recorded_at: evaluatedAt },
    allowed_claims: [
      { text: "ZoomInfo reports ScaleGrid has 900 employees.", evidence_ids: ["nps-enrichment"] },
      { text: "HubSpot recorded a demo request, pricing-page visit, and reply for ScaleGrid.", evidence_ids: ["nps-intent"] }
    ],
    disallowed_claims: ["ScaleGrid has recent public news."]
  },
  {
    request_id: requestId,
    evaluation_id: "eval-weak-opens",
    lead_id: "weak-opens",
    account_id: "acct-northstar",
    evaluation_timestamp: evaluatedAt,
    score_version: scoreVersion,
    lead_identity: {
      name: "Marcus Bell",
      title: "Head of Sales",
      company: "Northstar Apps",
      email: "marcus@northstar.example",
      domain: "northstar.example"
    },
    crm_context: {
      owner: "Sam Rivera",
      source: "Sequence",
      lifecycle_stage: "lead",
      routing_status: "open",
      open_opportunity_status: "none",
      company_association: { status: "resolved", basis: "sole", candidate_account_ids: ["acct-northstar"] },
      duplicate_status: "clear",
      domain_status: "verified",
      evidence: [evidence("wo-crm-stage", "HubSpot", "crm", "High", "Open", 0)]
    },
    priority_score: 54,
    priority_band: "Cold",
    confidence: "Medium",
    manual_review_reasons: [],
    reason: "ICP fit is positive, but opens alone are not reliable buying intent.",
    hook: "No grounded hook available — no recent verified signal found.",
    enrichment_fields: {
      employees: 420,
      revenue_band: "$25M-$50M",
      tech_stack: ["Salesforce"],
      last_updated_days_ago: 46,
      evidence: [evidence("wo-enrichment", "Clearbit", "enrichment", "High", 420, 46, true, undefined, "numberofemployees", { employees: 420, revenue_band: "$25M-$50M", tech_stack: ["Salesforce"] })]
    },
    intent_signals: {
      surge: false,
      evidence: []
    },
    engagement_signals: {
      opens: 5,
      clicks: 0,
      replies: 0,
      demo_request: false,
      pricing_page_visit: false,
      evidence: [evidence("wo-intent", "Outreach", "engagement", "Medium", "5 email opens", 4, false, undefined, undefined, { opens: 5 })]
    },
    public_signals: [],
    score_breakdown: {
      icp_fit: 30,
      high_intent_actions: 0,
      engagement_quality: 10,
      public_timing_signals: 0,
      crm_process_context: 9,
      data_confidence: 5
    },
    validation_evidence: [],
    missing_fields: ["public_signals"],
    stale_fields: [],
    source_conflicts: [],
    tool_status: toolStatus({ fetch_public_signals: { status: "no_result", completed_at: evaluatedAt, detail: "No verified public signals found." } }),
    writeback_plan: { decision: "Eligible", reason: "Firmographic enrichment is fresh; engagement is not written back." },
    writeback_outcome: { status: "Skipped", reason: "Live CRM writeback is disabled for fixture evaluations.", recorded_at: evaluatedAt },
    allowed_claims: [
      { text: "Clearbit reports Northstar Apps has 420 employees.", evidence_ids: ["wo-enrichment"] },
      { text: "Outreach recorded 5 email opens for Northstar Apps.", evidence_ids: ["wo-intent"] }
    ],
    disallowed_claims: ["Northstar Apps is showing buying intent from email opens alone."]
  },
  {
    request_id: requestId,
    evaluation_id: "eval-stale-writeback",
    lead_id: "stale-writeback",
    account_id: "acct-harborworks",
    evaluation_timestamp: evaluatedAt,
    score_version: scoreVersion,
    lead_identity: {
      name: "Nora Patel",
      title: "IT Manager",
      company: "HarborWorks",
      email: "nora@harborworks.example",
      domain: "harborworks.example"
    },
    crm_context: {
      owner: "Jordan Lee",
      source: "List import",
      lifecycle_stage: "lead",
      routing_status: "open",
      open_opportunity_status: "none",
      company_association: { status: "resolved", basis: "primary", candidate_account_ids: ["acct-harborworks"] },
      duplicate_status: "clear",
      domain_status: "verified",
      evidence: [evidence("sw-crm-stage", "HubSpot", "crm", "High", "Open", 0)]
    },
    priority_score: null,
    priority_band: "Needs Manual Review",
    confidence: "Low",
    manual_review_reasons: ["source_conflict"],
    reason: "Fit data is stale and company size conflicts across sources.",
    hook: "No grounded hook available — no recent verified signal found.",
    enrichment_fields: {
      employees: 300,
      revenue_band: "$10M-$25M",
      tech_stack: [],
      last_updated_days_ago: 420,
      evidence: [
        evidence("sw-clearbit-enrichment", "Clearbit", "enrichment", "Low", 300, 420, false, undefined, undefined, { employees: 300, revenue_band: "$10M-$25M" }),
        evidence("sw-hubspot-employees", "HubSpot", "crm", "Medium", 75, 10, false, undefined, undefined, { employees: 75 })
      ]
    },
    intent_signals: {
      surge: false,
      evidence: []
    },
    engagement_signals: {
      opens: 0,
      clicks: 0,
      replies: 0,
      demo_request: false,
      pricing_page_visit: false,
      evidence: []
    },
    public_signals: [],
    score_breakdown: {
      icp_fit: 0,
      high_intent_actions: 0,
      engagement_quality: 0,
      public_timing_signals: 0,
      crm_process_context: 5,
      data_confidence: 0
    },
    validation_evidence: [],
    missing_fields: ["public_signals"],
    stale_fields: ["employees"],
    source_conflicts: ["Company size differs between Clearbit and HubSpot."],
    tool_status: toolStatus({
      fetch_intent_triggers: { status: "no_result", completed_at: evaluatedAt, detail: "No verified intent or engagement signals found." },
      fetch_public_signals: { status: "no_result", completed_at: evaluatedAt, detail: "No verified public signals found." }
    }),
    writeback_plan: { decision: "Review", reason: "Company-size data is stale and conflicts with CRM." },
    writeback_outcome: { status: "Flagged for Review", reason: "The deterministic plan requires review.", recorded_at: evaluatedAt },
    allowed_claims: [
      { text: "Clearbit reports HarborWorks has 300 employees, but HubSpot reports 75 employees.", evidence_ids: ["sw-clearbit-enrichment", "sw-hubspot-employees"] },
      { text: "Clearbit company-size data for HarborWorks is 420 days old.", evidence_ids: ["sw-clearbit-enrichment"] }
    ],
    disallowed_claims: ["HarborWorks has 300 employees without qualification."]
  }
];
