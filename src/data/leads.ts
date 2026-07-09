import type { Confidence, Evidence, LeadPacket, SourceType } from "../lib/contextai";

const evaluatedAt = "2026-07-09T09:00:00.000Z";
const scoreVersion = "score-v0.1";

const evidence = (
  source_name: string,
  source_type: SourceType,
  confidence: Confidence,
  value: string | number | boolean | string[],
  daysAgo: number,
  eligible_for_crm_writeback = false,
  source_url?: string
): Evidence => {
  const sourceDate = new Date(Date.parse(evaluatedAt) - daysAgo * 24 * 60 * 60 * 1000).toISOString();
  return {
    source_name,
    source_type,
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
      stage: "Open",
      evidence: [evidence("HubSpot", "crm", "High", "Open", 0)]
    },
    priority_score: 94,
    priority_band: "Hot",
    confidence: "High",
    reason: "Strong ICP fit plus demo-request and pricing-page intent.",
    hook: "Reference EnterpriseCorp's Series B funding announced on July 1, 2026.",
    enrichment_fields: {
      employees: 500,
      revenue_band: "$50M-$100M",
      tech_stack: ["Salesforce"],
      last_updated_days_ago: 18,
      evidence: [evidence("Clearbit", "enrichment", "High", "500 employees", 18, true)]
    },
    intent_signals: {
      opens: 2,
      clicks: 1,
      replies: 0,
      demo_request: true,
      pricing_page_visit: true,
      surge: false,
      evidence: [evidence("HubSpot", "intent", "High", "Demo request and pricing page visit", 1)]
    },
    public_signals: [{
      label: "Series B funding announced",
      source: "Crunchbase",
      days_ago: 8,
      evidence: [evidence("Crunchbase", "public_signal", "High", "Series B funding announced on July 1, 2026", 8, false, "https://example.com/enterprisecorp-series-b")]
    }],
    score_breakdown: {
      icp_fit: 30,
      high_intent_actions: 25,
      engagement_quality: 14,
      public_timing_signals: 15,
      crm_process_context: 5,
      data_confidence: 5
    },
    missing_fields: [],
    stale_fields: [],
    source_conflicts: [],
    writeback_recommendation: { decision: "Eligible", reason: "Verified enrichment is fresh and source-backed." },
    allowed_claims: [
      { text: "Clearbit reports EnterpriseCorp has 500 employees.", evidence_source: "Clearbit" },
      { text: "HubSpot recorded a demo request and pricing-page visit for EnterpriseCorp.", evidence_source: "HubSpot" },
      { text: "EnterpriseCorp announced a Series B funding round on July 1, 2026, according to Crunchbase.", evidence_source: "Crunchbase" }
    ],
    disallowed_claims: ["EnterpriseCorp is likely investing in sales automation after its Series B."]
  },
  {
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
      stage: "Open",
      evidence: [evidence("HubSpot", "crm", "High", "Open", 0)]
    },
    priority_score: 60,
    priority_band: "Warm",
    confidence: "Medium",
    reason: "Below headcount fit threshold, but strong recent category intent.",
    hook: "No grounded hook available - no recent verified signal found.",
    enrichment_fields: {
      employees: 12,
      revenue_band: "Data unavailable",
      tech_stack: [],
      last_updated_days_ago: 22,
      evidence: [evidence("Apollo", "enrichment", "Medium", "12 employees", 22)]
    },
    intent_signals: {
      opens: 0,
      clicks: 0,
      replies: 0,
      demo_request: false,
      pricing_page_visit: false,
      surge: true,
      evidence: [evidence("Bombora", "intent", "Medium", "Category surge", 2)]
    },
    public_signals: [],
    score_breakdown: {
      icp_fit: 10,
      high_intent_actions: 25,
      engagement_quality: 10,
      public_timing_signals: 0,
      crm_process_context: 10,
      data_confidence: 5
    },
    missing_fields: ["revenue_band", "public_signals"],
    stale_fields: [],
    source_conflicts: [],
    writeback_recommendation: { decision: "Review", reason: "Company size is verified, but account is below fit threshold." },
    allowed_claims: [{ text: "Bombora reported a category surge for LeanTech 2 days before evaluation.", evidence_source: "Bombora" }],
    disallowed_claims: ["LeanTech is ready to buy because category intent increased."]
  },
  {
    lead_id: "no-usable-data",
    account_id: "acct-test-error",
    evaluation_timestamp: evaluatedAt,
    score_version: scoreVersion,
    lead_identity: {
      name: "Unknown User",
      title: "Data unavailable",
      company: "test-error.com",
      email: "unknown@test-error.com",
      domain: "test-error.com"
    },
    crm_context: {
      owner: "Maya Chen",
      source: "Reassigned lead",
      stage: "Needs research",
      evidence: [evidence("HubSpot", "crm", "Medium", "Needs research", 0)]
    },
    priority_score: null,
    priority_band: "Needs Manual Review",
    confidence: "Low",
    reason: "Insufficient firmographic and behavioral data to score.",
    hook: "No grounded hook available - no recent verified signal found.",
    enrichment_fields: { tech_stack: [], evidence: [] },
    intent_signals: {
      opens: 0,
      clicks: 0,
      replies: 0,
      demo_request: false,
      pricing_page_visit: false,
      surge: false,
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
    missing_fields: ["employees", "revenue_band", "intent_signals", "public_signals"],
    stale_fields: [],
    source_conflicts: [],
    writeback_recommendation: { decision: "Skipped", reason: "No schema-valid enrichment available." },
    allowed_claims: [{ text: "Required scoring fields are missing for test-error.com: employees, revenue band, intent signals, and public signals.", evidence_source: "ContextAI validation" }],
    disallowed_claims: ["The lead has enough verified context for outreach."]
  },
  {
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
      stage: "Open",
      evidence: [evidence("HubSpot", "crm", "High", "Open", 0)]
    },
    priority_score: 83,
    priority_band: "Hot",
    confidence: "High",
    reason: "Strong fit and high engagement from verified intent signals.",
    hook: "No grounded hook available - no recent verified signal found.",
    enrichment_fields: {
      employees: 900,
      revenue_band: "$100M-$250M",
      tech_stack: ["HubSpot", "Salesforce"],
      last_updated_days_ago: 31,
      evidence: [evidence("ZoomInfo", "enrichment", "High", "900 employees", 31, true)]
    },
    intent_signals: {
      opens: 1,
      clicks: 2,
      replies: 1,
      demo_request: true,
      pricing_page_visit: true,
      surge: true,
      evidence: [evidence("HubSpot", "intent", "High", "Demo request, pricing page visit, and reply", 3)]
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
    missing_fields: ["public_signals"],
    stale_fields: [],
    source_conflicts: [],
    writeback_recommendation: { decision: "Eligible", reason: "Firmographic fields are fresh and verified." },
    allowed_claims: [
      { text: "ZoomInfo reports ScaleGrid has 900 employees.", evidence_source: "ZoomInfo" },
      { text: "HubSpot recorded a demo request, pricing-page visit, and reply for ScaleGrid.", evidence_source: "HubSpot" }
    ],
    disallowed_claims: ["ScaleGrid has recent public news."]
  },
  {
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
      stage: "Open",
      evidence: [evidence("HubSpot", "crm", "High", "Open", 0)]
    },
    priority_score: 54,
    priority_band: "Cold",
    confidence: "Medium",
    reason: "ICP fit is positive, but opens alone are not reliable buying intent.",
    hook: "No grounded hook available - no recent verified signal found.",
    enrichment_fields: {
      employees: 420,
      revenue_band: "$25M-$50M",
      tech_stack: ["Salesforce"],
      last_updated_days_ago: 46,
      evidence: [evidence("Clearbit", "enrichment", "High", "420 employees", 46, true)]
    },
    intent_signals: {
      opens: 5,
      clicks: 0,
      replies: 0,
      demo_request: false,
      pricing_page_visit: false,
      surge: false,
      evidence: [evidence("Outreach", "intent", "Medium", "5 email opens", 4)]
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
    missing_fields: ["public_signals"],
    stale_fields: [],
    source_conflicts: [],
    writeback_recommendation: { decision: "Eligible", reason: "Firmographic enrichment is fresh; intent is not written back." },
    allowed_claims: [
      { text: "Clearbit reports Northstar Apps has 420 employees.", evidence_source: "Clearbit" },
      { text: "Outreach recorded 5 email opens for Northstar Apps.", evidence_source: "Outreach" }
    ],
    disallowed_claims: ["Northstar Apps is showing buying intent from email opens alone."]
  },
  {
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
      stage: "Open",
      evidence: [evidence("HubSpot", "crm", "High", "Open", 0)]
    },
    priority_score: null,
    priority_band: "Needs Manual Review",
    confidence: "Low",
    reason: "Fit data is stale and company size conflicts across sources.",
    hook: "No grounded hook available - no recent verified signal found.",
    enrichment_fields: {
      employees: 300,
      revenue_band: "$10M-$25M",
      tech_stack: [],
      last_updated_days_ago: 420,
      evidence: [
        evidence("Clearbit", "enrichment", "Low", "300 employees", 420, false),
        evidence("HubSpot", "crm", "Medium", "75 employees", 10, false)
      ]
    },
    intent_signals: {
      opens: 0,
      clicks: 0,
      replies: 0,
      demo_request: false,
      pricing_page_visit: false,
      surge: false,
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
    missing_fields: ["public_signals"],
    stale_fields: ["employees"],
    source_conflicts: ["Company size differs between Clearbit and HubSpot."],
    writeback_recommendation: { decision: "Review", reason: "Company-size data is stale and conflicts with CRM." },
    allowed_claims: [
      { text: "Clearbit reports HarborWorks has 300 employees, but HubSpot reports 75 employees.", evidence_source: "Clearbit; HubSpot" },
      { text: "Clearbit company-size data for HarborWorks is 420 days old.", evidence_source: "Clearbit" }
    ],
    disallowed_claims: ["HarborWorks has 300 employees without qualification."]
  }
];
