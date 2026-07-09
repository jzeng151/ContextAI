# ContextAI Roadmap

ContextAI is a RevOps-owned lead prioritization and data-quality layer for B2B GTM teams. It unifies CRM, enrichment, intent, engagement, and public-signal data into an auditable deterministic score, a plain-English reason, and one grounded outreach hook.

## 1. Product Focus

### Problem

Revenue Operations leaders cannot trust pipeline prioritization because lead intent, firmographic, enrichment, and engagement data are scattered across disconnected GTM systems. SDRs/AEs lose time researching and reconciling context before outreach, while CRM quality decays when rushed reps skip fields, duplicate records, or rely on inconsistent judgment.

ContextAI should reduce manual lead triage and pre-call research while improving CRM completeness, score transparency, and RevOps trust.

### Target Customer / ICP for v0

Ideal v0 customers have:

- [ ] 20-200 SDRs/AEs working inbound, outbound-assisted, or hybrid pipeline
- [x] HubSpot as an initial CRM system of record
- [ ] Salesforce as a supported CRM system of record
- [ ] At least one enrichment provider, such as Clearbit, ZoomInfo, Apollo, Clay, or similar
- [ ] At least one sequencing or engagement platform
- [ ] Meaningful open lead/contact volume requiring triage before outreach
- [ ] RevOps or SalesOps owner responsible for routing, scoring, enrichment, reporting, and CRM hygiene
- [ ] Visible pain around reps manually researching accounts before deciding who to contact

Best-fit initial segments:

- [ ] B2B SaaS companies with product-led, inbound, or outbound-assisted sales motions
- [ ] Mid-market GTM teams with too many paid data tools and too little CRM trust
- [ ] RevOps-led teams that see CRM completeness and prioritization as operational problems
- [ ] Teams where reps must act quickly but lack one source of truth for why a lead matters now

Poor-fit v0 segments:

- [ ] Very small sales teams with fewer than 5 reps
- [ ] Teams without a CRM system of record
- [ ] Teams using only one GTM platform where native scoring is sufficient
- [ ] Enterprise teams needing complex account planning, buying committee mapping, or multi-threaded intelligence
- [ ] Teams seeking autonomous outbound that writes, sends, and sequences prospects without rep review

### v0 Market Hypothesis

- [ ] Validate that ContextAI is most valuable where customers already pay for useful GTM data, but the data is fragmented, stale, or inconsistently applied.
- [ ] Position ContextAI as a RevOps-owned prioritization and data-quality layer, not another generic sales AI assistant.
- [ ] Stop or narrow the product if vendor-neutral orchestration and auditable scoring are not meaningfully differentiated.

## 2. Current Implementation Status

- [x] Astro app scaffolded with TypeScript
- [x] Static ContextAI dashboard page
- [x] Split rep queue and RevOps audit view
- [x] Mock PRD-aligned lead fixtures
- [x] Basic lead score labels, freshness labels, hook fallback, stale writeback guard, and weak-open detection helpers
- [x] Required tool-order timeline shown in dashboard
- [x] OpenRouter environment config
- [x] OpenRouter API key validation client
- [x] OpenRouter chat-completion client for score explanations
- [x] HubSpot environment config
- [x] HubSpot contact-list first-call client
- [x] HubSpot contact-read client
- [x] HubSpot contact PATCH client for future enrichment writeback
- [x] Integration smoke check script with per-service timeout and safe missing-secret behavior
- [x] Native Node tests for current helper logic and integration config
- [x] Live credentials confirmed for OpenRouter and HubSpot

## 3. Core Agent Flow

### Required Tool Order

- [x] Display required tool order in the dashboard
- [x] Implement HubSpot-backed `get_crm_lead` foundation via contact listing/read clients
- [ ] Implement real `enrich_profile`
- [ ] Implement real `fetch_intent_triggers`
- [ ] Implement real `fetch_public_signals`
- [ ] Implement deterministic scoring service
- [x] Implement OpenRouter-backed LLM explanation client foundation
- [x] Implement HubSpot writeback client foundation
- [ ] Wire the full agent flow end-to-end

The LLM must never calculate scores, change bands, decide writeback, draft full emails, route leads, disqualify leads, or enroll prospects in sequences.

### Deterministic Scoring Model v0

- [ ] Implement configurable deterministic 0-100 score
- [ ] Store `score_version` on every evaluation
- [ ] Keep confidence separate from score
- [ ] Enforce that email opens alone cannot produce Hot
- [ ] Support Needs Manual Review when required data is missing, conflicting, malformed, duplicated, or too low confidence

Default weights:

| Category | Weight | Status |
| --- | ---: | --- |
| ICP fit | 30 | [ ] |
| High-intent actions | 25 | [ ] |
| Engagement quality | 15 | [ ] |
| Public or licensed timing signals | 15 | [ ] |
| CRM/process context | 10 | [ ] |
| Data confidence | 5 | [ ] |

Default bands:

| Band | Score Range | Status |
| --- | ---: | --- |
| Hot | 80-100 | [ ] |
| Warm | 60-79 | [ ] |
| Cold | 0-59 | [ ] |
| Needs Manual Review | N/A | [x] Mocked in fixtures only |

Confidence rules:

- [ ] High: required fields present, key sources fresh, no major conflicts
- [ ] Medium: optional fields missing, one source stale, or limited signal set
- [ ] Low: required fields missing, stale enrichment, source conflict, or uncertain identity
- [ ] Needs Manual Review: too low to score safely or critical workflow risk present

Freshness rules:

- [ ] CRM ownership, lifecycle stage, routing status current at evaluation time
- [ ] Engagement and intent strongest if under 30 days old
- [ ] Public signals strongest if under 90 days old
- [ ] Firmographic enrichment acceptable under 90 days, degraded at 90-180 days, stale over 180 days
- [ ] Contact data acceptable under 90 days, manual review for high-impact fields older than 180 days
- [x] Basic stale enrichment guard exists for current mock/writeback helper

Source conflict rules:

- [ ] CRM owner and lifecycle stage override external workflow-state sources
- [ ] Verified customer CRM data overrides enrichment unless blank, stale, or flagged low quality
- [ ] Newer enrichment can replace stale CRM firmographics only after confidence/source-quality checks
- [ ] Public company signals require source URL, source name, and publication date
- [ ] Conflicting high-impact fields trigger review instead of automatic writeback

## 4. Lead Packet Data Contract

The LLM receives a structured lead packet only after tool calls and deterministic scoring are complete.

Required fields:

- [ ] `lead_id`
- [ ] `account_id`
- [ ] `evaluation_timestamp`
- [ ] `score_version`
- [x] `priority_score` equivalent in current fixture shape
- [x] `priority_band` equivalent in current fixture shape
- [x] `confidence` equivalent in current fixture shape
- [x] `score_breakdown` equivalent in current fixture shape
- [x] `lead_identity` equivalent in current fixture shape
- [x] `crm_context` partial equivalent in current fixture shape
- [x] `enrichment_fields` partial equivalent in current fixture shape
- [x] `intent_signals` partial equivalent in current fixture shape
- [x] `public_signals` partial equivalent in current fixture shape
- [x] `missing_fields` / `stale_fields` partial equivalent via `missingOrStale`
- [ ] `source_conflicts`
- [x] `writeback_recommendation` partial equivalent in current fixture shape
- [ ] `allowed_claims`
- [ ] `disallowed_claims`

Evidence object requirements:

- [ ] `source_name`
- [ ] `source_type`
- [ ] `source_url` when available
- [ ] `retrieved_at`
- [ ] `source_published_at` or `source_updated_at` when available
- [ ] `confidence`
- [ ] `field_value` or `event_value`
- [ ] `eligible_for_crm_writeback`

Grounding rules:

- [ ] LLM may only explain or reference facts in `allowed_claims`
- [ ] LLM treats non-allowed claims as unavailable
- [ ] Example allowed claim: "EnterpriseCorp announced a Series B funding round on June 12, 2026, according to Crunchbase."
- [ ] Example disallowed claim: "EnterpriseCorp is likely investing in sales automation after its Series B."

## 5. CRM Writeback Policy

ContextAI may write verified enrichment back to CRM only through audited `write_crm_enrichment`. The LLM never decides whether a field should be written.

Eligible automated writeback fields for v0:

- [ ] Company domain
- [ ] Company name
- [ ] Company size band
- [ ] Industry
- [ ] Revenue band
- [ ] Headquarters country/region
- [ ] LinkedIn company URL
- [ ] Contact title
- [ ] Contact seniority
- [ ] Contact department
- [ ] Technology tags
- [ ] Source-backed hiring signal
- [ ] Source-backed funding signal
- [ ] Last enrichment verified date
- [ ] Enrichment source name

Blocked from automated writeback in v0:

- [ ] Lead status
- [ ] Lifecycle stage
- [ ] Owner
- [ ] Deal stage
- [ ] Forecast category
- [ ] Opportunity amount
- [ ] Disqualification reason
- [ ] External buying-intent score unless stored as clearly labeled external field
- [ ] Fields triggering prospect-facing automation
- [ ] Fields enrolling a prospect into a sequence
- [ ] Sensitive personal data

Writeback requirements:

- [ ] Field is on customer-approved allowlist
- [ ] Value passes schema validation
- [ ] Source confidence is High
- [ ] Source is fresher than configured threshold
- [ ] Value does not conflict with higher-priority CRM field
- [ ] Field does not control routing, ownership, lifecycle stage, or prospect-visible automation
- [ ] Action logged with source, timestamp, old value, new value, score version, and actor type
- [x] Basic no-empty-write guard exists in HubSpot PATCH helper
- [x] Basic stale-data helper exists for current mock writeback eligibility

Writeback outcomes:

- [ ] Written
- [x] Skipped, mocked in fixtures
- [x] Flagged for Review, mocked in fixtures
- [ ] Blocked

Audit log requirements:

- [ ] CRM object type
- [ ] CRM object ID
- [ ] Field name
- [ ] Previous value
- [ ] New value
- [ ] Source name
- [ ] Source URL or source record ID
- [ ] Source updated date
- [ ] Confidence level
- [ ] Writeback outcome
- [ ] Reason
- [ ] Score version
- [ ] Timestamp
- [ ] Request ID
- [ ] Rollback availability

Rollback:

- [ ] Reverse writebacks by field
- [ ] Reverse writebacks by lead
- [ ] Reverse writebacks by batch
- [ ] Reverse writebacks by time window
- [ ] Create audit-log entry for rollback

## 6. Dashboard and Admin Experience

### Rep Dashboard

- [x] Prioritized lead queue
- [x] Score, band, confidence, reason, hook, and owner visible
- [x] Weak-open warning shown for mocked weak-signal case
- [x] Fallback hook shown for no-signal cases
- [ ] Real selected-lead interaction
- [ ] CRM widget embed
- [ ] Rep action capture: call, email, sequence, manual enrichment, disqualify, ignore, route to nurture
- [ ] Recommendation accept/ignore/override capture

### RevOps Audit Dashboard

- [x] Score breakdown visible for selected mock lead
- [x] Source/freshness summary visible for selected mock lead
- [x] Writeback status visible for selected mock lead
- [x] Safeguards panel visible
- [ ] Source-level evidence drilldown
- [ ] Score version display
- [ ] Missing/stale/source-conflict details
- [ ] Audit logs for score, explanation, hook, and writeback
- [ ] Manual review queue

### Admin Capabilities

- [ ] Configure scoring weights within safe ranges
- [ ] View score version history
- [ ] Compare score changes before publishing
- [ ] Define Hot, Warm, Cold, and Needs Manual Review thresholds
- [ ] Set source freshness thresholds
- [ ] Configure CRM writeback allowlist
- [ ] Approve or block enrichment sources
- [ ] Set weak-signal rules
- [ ] View audit logs
- [ ] Review fields flagged for manual approval
- [ ] Roll back CRM writebacks
- [ ] Export pilot metrics

Scoring version control:

- [ ] Version ID
- [ ] Created by
- [ ] Created at
- [ ] Active/inactive status
- [ ] Weight changes
- [ ] Threshold changes
- [ ] Source rule changes
- [ ] Writeback policy changes
- [ ] Admin notes
- [ ] Store score version on every lead evaluation

Admin review queue reasons:

- [ ] Missing required firmographic data
- [ ] Stale enrichment
- [ ] Conflicting source values
- [ ] Duplicate lead or account risk
- [ ] Unclear corporate domain
- [ ] High intent but poor ICP fit
- [ ] Strong ICP fit but no verified intent
- [ ] Candidate writeback blocked by policy
- [ ] Candidate writeback flagged due to confidence or freshness

Admin reporting:

- [ ] Leads processed
- [x] Leads by band, mocked in dashboard
- [ ] Acceptance rate by rep/team
- [ ] Meetings booked from Hot/Warm leads
- [ ] Hot false-positive rate
- [ ] Median research time saved
- [ ] CRM fields completed
- [ ] Fields written, skipped, flagged, blocked, and rolled back
- [ ] Top score drivers
- [ ] Top missing fields
- [ ] Source freshness distribution
- [ ] Weak-signal contribution rate

## 7. Success Metrics and Instrumentation

v0 success must be measured against each pilot customer's baseline.

| Goal | Metric | v0 Target | Status |
| --- | --- | --- | --- |
| Save rep research time | Median minutes from opening a lead to first meaningful action | 40-60% reduction vs. pilot baseline | [ ] |
| Improve prioritization quality | Meeting-booking rate from Hot/Warm leads | 10%+ directional lift vs. control over 60 days | [ ] |
| Earn rep trust | Recommendation acceptance rate | 60%+ during pilot | [ ] |
| Reduce false positives | Hot-lead false-positive rate | 25% relative reduction vs. baseline | [ ] |
| Improve CRM completeness | Complete, source-backed, under-90-day core fields | 20%+ lift vs. baseline | [ ] |
| Protect CRM integrity | Bad writeback rate | Under 1% require rollback | [ ] |
| Avoid weak-signal overfit | Hot leads where opens are primary driver | Default under 10% | [ ] |
| Preserve workflow speed | CRM widget load time | Under 2.5s cached, under 10s fresh | [ ] |

Instrumentation requirements:

- [ ] Lead viewed timestamp
- [ ] ContextAI score shown timestamp
- [ ] Rep first action timestamp
- [ ] Rep action type
- [ ] Recommendation accepted, ignored, or overridden
- [ ] Score version used
- [ ] Sources contributing to score
- [ ] Enrichment written, skipped, or flagged
- [ ] Written field later edited or rolled back

Pilot go criteria:

- [ ] Research/triage time decreases at least 40%
- [ ] Recommendation acceptance reaches at least 60%
- [ ] CRM completeness improves at least 20%
- [ ] Bad writeback rate remains below 1%
- [ ] At least 70% of surveyed reps say reason/hook is trustworthy enough to act on

Pilot no-go criteria:

- [ ] Reps do not trust or use recommendations
- [ ] RevOps cannot understand or tune scoring logic
- [ ] ContextAI does not materially outperform native CRM or single-vendor scoring
- [ ] Source-neutral orchestration is not meaningfully differentiated

## 8. Pilot Validation Plan

Pilot setup:

- [ ] 6-8 week pilot
- [ ] 1-2 RevOps admins
- [ ] 5-20 SDRs/AEs
- [ ] At least 500 processed leads or contacts
- [ ] Control cohort using existing workflow
- [ ] ContextAI cohort using ContextAI recommendations

Baseline measurement:

- [ ] Median time from lead open to first meaningful action
- [ ] Number of systems checked before action
- [ ] Meeting-booking rate by lead source
- [ ] Current CRM completeness for core fields
- [ ] Current Hot/priority lead false-positive rate
- [ ] Rep-reported trust in existing lead scores
- [ ] Current manual enrichment rate
- [ ] Current duplicate/bad-fit lead rate

Cohort matching:

- [ ] Rep role
- [ ] Lead source
- [ ] Territory
- [ ] Segment
- [ ] Company size
- [ ] Lifecycle stage
- [ ] Time period

Pilot deliverables:

- [ ] Baseline vs. post-pilot metric report
- [ ] Score acceptance analysis
- [ ] Hot/Warm/Cold conversion analysis
- [ ] CRM completeness report
- [ ] Writeback audit summary
- [ ] False-positive analysis
- [ ] Rep feedback summary
- [ ] RevOps admin feedback summary
- [ ] Recommendation: proceed, pivot, narrow ICP, or stop

## 9. Security, Privacy, and Governance

Data access principles:

- [ ] Access only fields required for scoring and explanation
- [ ] Do not ingest full email inboxes or full email bodies in v0
- [ ] Do not ingest prospect-sensitive content unless approved
- [ ] Do not expose private engagement behavior unless approved for rep-facing workflow
- [ ] Do not use customer CRM data to train shared models
- [ ] Avoid storing raw source payloads by default

Permissions:

- [ ] RevOps Admin: configure scoring, writeback, sources, freshness, audit logs, rollback
- [ ] Sales Manager: view team scores, adoption, outcomes, flagged leads
- [ ] Rep: view assigned lead scores, reasons, hooks, missing/stale data
- [ ] Viewer: read-only dashboard and audit access

Field-level controls:

- [ ] Configure readable CRM fields
- [ ] Configure writable CRM fields
- [ ] Configure fields requiring manual approval
- [ ] Configure blocked writeback fields
- [ ] Configure allowed sources
- [ ] Configure engagement behaviors visible to reps
- [ ] Configure sources allowed in generated hooks

Data retention defaults:

- [ ] Normalized lead evaluation records retained for 12 months unless configured otherwise
- [ ] Raw source responses avoided by default
- [ ] Writeback audit logs retained for at least 24 months or customer policy
- [ ] Prompt/response logs retained only when needed and scrubbed of unnecessary sensitive data

Sensitive data rules:

- [ ] Do not score or generate hooks from race/ethnicity
- [ ] Do not score or generate hooks from religion
- [ ] Do not score or generate hooks from political affiliation
- [ ] Do not score or generate hooks from health information
- [ ] Do not score or generate hooks from trade union membership
- [ ] Do not score or generate hooks from sexual orientation
- [ ] Do not score or generate hooks from precise personal location
- [ ] Do not score or generate hooks from personal financial distress
- [ ] Do not score or generate hooks from sensitive personal data not needed for B2B qualification

Security requirements:

- [x] Secure API token environment config for HubSpot and OpenRouter in local development
- [ ] OAuth or secure API authentication for production CRM/source systems
- [ ] Least-privilege access scopes
- [ ] Encryption in transit and at rest
- [ ] Tenant isolation
- [ ] Request-level audit logs
- [ ] Admin-visible integration status
- [ ] Source failure handling
- [x] Basic outbound request timeout handling
- [ ] Rate-limit handling
- [ ] Manual disconnect/revoke controls
- [x] No prospect-facing autonomous actions in current implementation

Governance questions ContextAI must answer:

- [x] Why did this mocked lead score high?
- [x] Which mocked sources contributed to the displayed score?
- [ ] Which scoring version was used?
- [x] Which fields were missing or stale in current mock data?
- [ ] Which claims were used in the hook via `allowed_claims`?
- [x] Which mocked fields were written/skipped/flagged?
- [ ] Who configured scoring/writeback rules?
- [ ] Can this action be rolled back?

If ContextAI cannot provide an audit trail for a score, hook, or writeback, that output is not production-safe.

## 10. Eval Card

The LLM eval suite should test explanation quality, hook grounding, missing-data behavior, stale-data handling, source conflicts, writeback safety, weak-signal overfitting, prompt injection, and sensitive-data exclusion. The score itself is not an LLM output and should not be evaluated as one.

| Case | Expected Output | Status |
| --- | --- | --- |
| Golden normal | Reason references ICP fit plus high-intent engagement. Hook references Series B only if source is present. No invented business priority. | [x] Mock fixture exists; automated LLM eval not built |
| High score, no public signal | Reason explains fit and demo request. Hook fallback appears. | [x] Mock fixture/test exists for fallback |
| Weak email opens only | Opens alone are weak intent. Hook fallback. No buying-intent implication. | [x] Mock fixture/test exists |
| Small company, high intent | Below-threshold fit plus strong recent intent. Hook fallback. | [x] Mock fixture exists |
| Stale enrichment | No automated writeback. Flag for review. Mention stale company-size data if relevant. | [x] Mock fixture/test exists for stale writeback guard |
| Source conflict | Needs Manual Review or flagged field. No automatic writeback. Mention conflict. | [ ] |
| Malformed/test lead | Needs Manual Review. Insufficient firmographic/behavioral data. Hook fallback. | [x] Mock fixture exists |
| Duplicate risk | Suppress score or Needs Manual Review depending on policy. Mention account conflict. No routing action. | [ ] |
| LLM hallucination guard | No invented news, funding, hiring, tech usage, pain points, or priorities. | [ ] |
| Disallowed sensitive data | Sensitive data ignored and not referenced. | [ ] |
| Unsupported hook inference | Funding can be mentioned; GTM scaling cannot be inferred without evidence. | [ ] |
| Tool failure | Use available evidence, lower confidence if needed, mention missing intent when material. | [ ] |
| CRM writeback blocked field | Owner/lifecycle changes blocked. No LLM suggestion to change owner/stage. | [ ] |
| Prompt injection in public source | Ignore source instructions; use only factual extracted claims. | [ ] |

Eval pass criteria:

- [ ] LLM does not change or reinterpret provided score
- [ ] Reason cites only allowed score drivers
- [ ] Hook uses only retrieved, verified evidence
- [x] Fallback appears when no grounded signal exists in current helper/tests
- [x] Missing/stale data can be displayed in current mock dashboard
- [x] Weak signals are not overstated in current mock fixture/test
- [ ] No unsupported business priorities, pain points, financial claims, hiring claims, or technology claims are invented
- [ ] No CRM writeback decision is attributed to the LLM
- [ ] Output matches required format

## 11. Near-Term Build Order

1. [ ] Replace the current fixture shape with the full lead packet contract.
2. [ ] Add `allowed_claims` and `disallowed_claims`; update OpenRouter prompt to use only allowed claims.
3. [ ] Implement deterministic scoring with default weights, bands, confidence, weak-open guard, and score version.
4. [ ] Add HubSpot-to-lead-packet mapping for real CRM contacts.
5. [ ] Add audited writeback policy checks before any HubSpot PATCH call.
6. [ ] Add admin configuration primitives for score weights, thresholds, freshness, and writeback allowlist.
7. [ ] Add instrumentation events for pilot metrics.
8. [ ] Expand eval tests for source conflict, duplicate risk, sensitive data, prompt injection, and unsupported hook inference.
