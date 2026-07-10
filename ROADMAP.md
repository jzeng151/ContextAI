# ContextAI Roadmap

ContextAI is a RevOps-owned lead prioritization and data-quality layer for B2B GTM teams. It unifies CRM, enrichment, intent, engagement, and public-signal data into an auditable deterministic score, a plain-English reason, and one grounded outreach hook.

This document is the delivery and status view of the PRD. The source-of-truth order is: `PRD.md` for product and safety requirements; shared schemas and active configuration for runtime contracts; this roadmap for phase and status; and GitHub issues for executable scope, dependencies, and acceptance criteria.

Implementation status below was reconciled against merged PR #10 and the local test/build on July 9, 2026. A checked foundation item does not mean the corresponding production path is pilot-ready.

## 1. Product Focus

### Problem

Revenue Operations leaders cannot trust pipeline prioritization because lead intent, firmographic, enrichment, and engagement data are scattered across disconnected GTM systems. SDRs/AEs lose time researching and reconciling context before outreach, while CRM quality decays when rushed reps skip fields, duplicate records, or rely on inconsistent judgment.

ContextAI should reduce manual lead triage and pre-call research while improving CRM completeness, score transparency, and RevOps trust.

### Target Customer / ICP for v0

Ideal v0 customers have:

- [ ] 20-200 SDRs/AEs working inbound, outbound-assisted, or hybrid pipeline
- [x] HubSpot as an initial CRM system of record
- [ ] Salesforce support after v0; it is not a pilot requirement
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
- [x] Lead packet contract foundation and evidence-backed fixtures merged in PR #10
- [ ] Close remaining PRD contract gaps for tool status, engagement semantics, CRM associations, and writeback outcome in #11
- [x] Contributor setup and workflow guide
- [x] Deterministic scoring service (`src/lib/scoring.ts`) with PRD weights, bands, confidence, and weak-open Hot guard

## 3. Core Agent Flow

### Required Tool Order

- [x] Display required tool order in the dashboard
- [x] Implement HubSpot-backed `get_crm_lead` foundation via contact listing/read clients
- [x] Implement `enrich_profile` ingestion wrapper (catalog + optional ENRICHMENT_API_URL)
- [x] Implement `fetch_intent_triggers` ingestion wrapper (catalog + optional INTENT_API_URL)
- [x] Implement `fetch_public_signals` ingestion wrapper (catalog + optional PUBLIC_SIGNALS_API_URL)
- [x] Implement deterministic scoring service
- [ ] Implement deterministic CRM writeback evaluation before LLM invocation
- [x] `write_crm_enrichment` read-only placeholder (no HubSpot PATCH)
- [x] Implement OpenRouter-backed LLM explanation client foundation
- [x] Implement HubSpot writeback client foundation
- [ ] Validate grounded LLM output against the required schema and evidence IDs
- [ ] Wire the full agent flow end-to-end

The LLM must never calculate scores, change bands, decide writeback, draft full emails, route leads, disqualify leads, or enroll prospects in sequences.

### Runtime, Persistence, and Evaluation Lifecycle

- [ ] Establish the server runtime, durable schemas, migrations, and append-only audit/event storage in #13
- [ ] Run a configured morning evaluation for each rep's assigned open records in #15
- [ ] Handle new-owner and reassignment events through an authenticated, deduplicated HubSpot trigger in #15
- [ ] Define contact/company eligibility, CRM-authoritative fields, association failure, duplicate risk, and manual-review behavior in #11/#15
- [ ] Add evaluation/request IDs, idempotency, concurrency limits, timeouts, retry/backoff, rate-limit handling, and recovery in #13/#15
- [ ] Persist every required step's terminal status and allow partial source failure without invented data
- [ ] Exercise one successful and one graceful-failure path from trigger through validated output and audit record

### Deterministic Scoring Model v0

- [x] Implement configurable deterministic 0-100 score
- [x] Store `score_version` on every evaluation
- [x] Keep confidence separate from score
- [x] Enforce that email opens alone cannot produce Hot
- [x] Support Needs Manual Review when required data is missing, conflicting, malformed, duplicated, or too low confidence

Default weights:

| Category | Weight | Status |
| --- | ---: | --- |
| ICP fit | 30 | [x] |
| High-intent actions | 25 | [x] |
| Engagement quality | 15 | [x] |
| Public or licensed timing signals | 15 | [x] |
| CRM/process context | 10 | [x] |
| Data confidence | 5 | [x] |

Default bands:

Implemented as Hot 80–100 / Warm 60–79 / Cold 0–59. The PRD's "54/100 Low Warm" weak-opens example maps to Cold under these thresholds (score 54, band Cold, confidence Medium).

| Band | Score Range | Status |
| --- | ---: | --- |
| Hot | 80-100 | [x] |
| Warm | 60-79 | [x] |
| Cold | 0-59 | [x] |
| Needs Manual Review | N/A | [x] |

Confidence rules:

- [x] High: required fields present, key sources fresh, no major conflicts
- [x] Medium: optional fields missing, one source stale, or limited signal set
- [x] Low: required fields missing, stale enrichment, source conflict, or uncertain identity
- [x] Needs Manual Review is a band with `priority_score: null` and Low confidence

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
- [ ] Public company signals require source name, publication date, and a URL or stable provider record ID when available
- [ ] Conflicting high-impact fields trigger review instead of automatic writeback

## 4. Lead Packet Data Contract

The LLM receives a structured lead packet only after required source calls, deterministic scoring, and CRM writeback evaluation have completed or failed gracefully. PR #10 established the foundation; #11 owns the remaining PRD alignment before downstream contracts are treated as locked.

Required fields:

- [x] `lead_id`
- [x] `account_id` in fixtures; define contact/company association and nullability in #11
- [x] `evaluation_timestamp`
- [x] `score_version`
- [x] `priority_score`
- [x] `priority_band`
- [x] `confidence`
- [x] `score_breakdown`
- [x] `lead_identity`
- [x] `crm_context`
- [x] `enrichment_fields`
- [x] `intent_signals`; define whether engagement remains canonical here or becomes a separate field in #11
- [x] `public_signals`
- [x] `missing_fields` / `stale_fields`
- [x] `source_conflicts`
- [x] `writeback_recommendation` foundation
- [ ] Per-step `tool_status`, including success, unavailable, timeout, rate-limited, and invalid results
- [ ] Deterministic `writeback_plan` and authoritative `writeback_outcome`
- [ ] Request/evaluation identifiers and incomplete-packet behavior
- [x] `allowed_claims`
- [x] `disallowed_claims`

Evidence object requirements:

- [x] `source_name`
- [x] `source_type`
- [x] `source_url` when available
- [x] `retrieved_at`
- [x] `source_published_at` or `source_updated_at` when available
- [x] `confidence`
- [x] `field_value` or `event_value`
- [x] `eligible_for_crm_writeback`

Grounding rules:

- [x] OpenRouter request includes `allowed_claims` and omits `disallowed_claims`
- [ ] Validate every factual output reference against an allowed claim and its evidence IDs in #6
- [ ] Reject or fall back on unsupported, stale, failed, sensitive, or disallowed output in #6
- [ ] Example allowed claim: "EnterpriseCorp announced a Series B funding round on June 12, 2026, according to Crunchbase."
- [ ] Example disallowed claim: "EnterpriseCorp is likely investing in sales automation after its Series B."

## 5. CRM Writeback Policy

ContextAI may write verified enrichment back to CRM only through audited `write_crm_enrichment`. The LLM never decides whether a field should be written.

Live writeback remains dry-run/feature-flagged until #4 proves schema, allowlist, source confidence/freshness, conflict precedence, blocked downstream side effects, idempotency, immutable audit, and rollback. Scoring freshness and writeback eligibility are separate policies; evidence usable for scoring is not automatically writable.

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

- [x] Field is on customer-approved allowlist
- [ ] Value passes schema validation
- [x] Source confidence is High
- [x] Source is fresher than configured threshold
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

- [ ] Reverse writebacks by field for v0
- [ ] Reverse writebacks by lead for v0
- [ ] Reverse writebacks by batch after v0 unless pilot evidence requires it
- [ ] Reverse writebacks by time window after v0 unless pilot evidence requires it
- [ ] Create audit-log entry for rollback

## 6. Dashboard and Admin Experience

### Rep Dashboard

- [x] Prioritized lead queue
- [x] Score, band, confidence, reason, hook, and owner visible
- [x] Weak-open warning shown for mocked weak-signal case
- [x] Fallback hook shown for no-signal cases
- [ ] Real selected-lead interaction in #7
- [ ] HubSpot CRM widget/embed in #17
- [ ] Capture call, email, sequence, manual enrichment, disqualify, ignore, and nurture as observed/linked rep actions in #7/#17; never execute them
- [ ] Recommendation accept/ignore/override capture through #9 events

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

Configuration primitives belong to #8; pilot-ready RevOps screens, review, audit, and rollback controls belong to #16; pilot metric reports and exports belong to #19.

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

#9 owns the append-only event contract and recording boundary. #19 owns read-only aggregation, reporting, and export after the producing workstreams exist.

The PRD explicitly sets the 40-60% research-time hypothesis and 60% acceptance target. Other numeric values below are provisional pilot operating targets introduced by this roadmap; #18 must approve their definitions, denominators, windows, and thresholds before the pilot.

| Goal | Metric | v0 Target | Status |
| --- | --- | --- | --- |
| Save rep research time | Median minutes from opening a lead to first meaningful action | 40-60% reduction vs. pilot baseline | [ ] |
| Improve prioritization quality | Meetings per rep and meeting-booking rate from Hot/Warm leads | 10%+ directional lift vs. control over 60 days (provisional) | [ ] |
| Earn rep trust | Recommendation acceptance rate | 60%+ during pilot | [ ] |
| Reduce false positives | Hot-lead false-positive rate | 25% relative reduction vs. baseline (provisional) | [ ] |
| Improve CRM completeness | Complete, source-backed, under-90-day core fields | 20%+ lift vs. baseline (provisional) | [ ] |
| Protect CRM integrity | Bad writeback rate | Under 1% require rollback (provisional) | [ ] |
| Avoid weak-signal overfit | Hot leads where opens are primary driver | Admin-defined; initial default under 10% (provisional) | [ ] |
| Preserve workflow speed | CRM widget load time | Under 2.5s cached, under 10s fresh (provisional) | [ ] |

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

#18 owns the metric dictionary, baseline instruments, cohort design, and decision rubric before exposure. #20 owns running the approved pilot and making the evidence-backed proceed/pivot/narrow/stop decision after #19 reporting is ready.

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

#14 owns the production integration-security, tenant, role, retention, health, and revoke controls required before a real pilot.

Data access principles:

- [ ] Access only fields required for scoring and explanation
- [ ] Do not ingest full email inboxes or full email bodies in v0
- [ ] Do not ingest prospect-sensitive content unless approved
- [ ] Do not expose private engagement behavior unless approved for rep-facing workflow
- [ ] Do not use customer CRM data to train shared models
- [ ] Avoid storing raw source payloads by default

Permissions:

- [ ] RevOps Admin for v0: configure scoring, writeback, sources, freshness, audit logs, and rollback
- [ ] Rep for v0: view assigned lead scores, reasons, hooks, and missing/stale data
- [ ] Sales Manager after v0: view team scores, adoption, outcomes, and flagged leads
- [ ] Viewer after v0: read-only dashboard and audit access

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

#6 owns deterministic claim compilation, runtime output validation, and the automated LLM eval gate. Relevant scoring and writeback invariants remain acceptance criteria in #3 and #4 rather than waiting for a final eval phase.

| Case | Expected Output | Status |
| --- | --- | --- |
| Golden normal | Reason references ICP fit plus high-intent engagement. Hook references Series B only if source is present. No invented business priority. | [x] Mock fixture exists; automated LLM eval not built |
| High score, no public signal | Reason explains fit and demo request. Hook fallback appears. | [x] Mock fixture/test exists for fallback |
| Weak email opens only | Opens alone are weak intent. Hook fallback. No buying-intent implication. | [x] Mock fixture/test exists |
| Small company, high intent | Below-threshold fit plus strong recent intent. Hook fallback. | [x] Mock fixture exists |
| Stale enrichment | No automated writeback. Flag for review. Mention stale company-size data if relevant. | [x] Mock fixture/test exists for stale writeback guard |
| Source conflict | Needs Manual Review or flagged field. No automatic writeback. Mention conflict. | [x] Mock fixture/test exists |
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

## 11. Delivery Plan and Issue Map

PR #10 completed the initial lead-packet/fixture foundation. Work now proceeds through explicit gates; an issue may use fixtures in parallel, but it is not complete until its production-facing acceptance criteria pass.

### Phase 0: Contract and Collaboration Foundation

1. [ ] #11 locks remaining product decisions and contract semantics.
2. [ ] #12 adds secret-free pull-request test/build checks and the review handoff template; it can run immediately in parallel.
3. [ ] #13 establishes the minimum server runtime, durable schemas, migrations, and append-only records after #11.

Only one developer owns shared contract files at a time. Merge #11 contract changes before both lanes build against different semantics.

### Phase 1: Two Parallel Build Lanes

| Decision layer | Workflow layer | Cross-cutting |
| --- | --- | --- |
| #8 versioned configuration primitives | #5 source/evidence adapters | #9 event contract first |
| #3 deterministic scoring | #4 writeback policy/audit/rollback against fixtures, then live sources | #13 persistence foundation |
| #6 claim compiler, grounded LLM validation, and evals | #7 fixture-backed standalone rep/audit UX | #19 metrics reporting after producers exist |

Recommended sequencing:

- Kickoff: one developer owns #11 while the other owns #12.
- After #11: decision developer runs #8 → #3 → #6; platform/workflow developer runs #13 → #5 → #4, then #7.
- Merge #9's narrow event contract before #3-#7 add emitters; whichever developer finishes a current item first can own that prerequisite PR.
- Start #19 aggregation only after the producing workstreams, #13, and #18's metric dictionary exist.
- #18 can define the pilot and metric dictionary after #11 while implementation continues; it must finish before #19.
- Keep `src/pages/index.astro` single-owner during #7 and keep shared packet/config/event changes in small prerequisite PRs.

### Phase 2: End-to-End Alpha and Production Boundary

1. [ ] #14 establishes the production authentication, tenant, role, retention, health, and revoke boundary after #13.
2. [ ] #15 maps HubSpot records, implements morning and assignment/reassignment triggers, and orchestrates the complete ordered flow in parallel with #14 where contracts permit.
3. [ ] #17 embeds the rep experience in HubSpot after #7, #14, and #15 expose stable authorized APIs.
4. [ ] Keep live CRM writes disabled until #4's full audit and rollback gate passes.

### Phase 3: Pilot Hardening and Validation

1. [ ] #16 builds minimum RevOps configuration, version publishing, audit, manual-review, and rollback controls.
2. [ ] #18 approves the metric dictionary, baselines, cohorts, surveys, safety stops, and decision rubric before exposure.
3. [ ] #19 implements read-only pilot metric aggregation, reports, and exports against that approved definition.
4. [ ] #20 runs the pilot and makes the proceed/pivot/narrow/stop decision.

### Issue Ownership Boundaries

| Issue | Owns | Primary dependencies |
| --- | --- | --- |
| #11 | Shared product/runtime contract decisions | Merged PR #10 |
| #12 | PR CI and contribution gates | None |
| #13 | Server runtime and persistence | #11 |
| #8 | Pure versioned config model | #11 |
| #3 | Deterministic score result | #8, #11 |
| #5 | Provider adapters and normalized evidence | #11 |
| #4 | Writeback plan, execution, audit, rollback | #8, #11, #13; #5 for live data |
| #6 | Allowed-claim compiler, LLM validator, evals | #3, #11; #5 for real-source completion |
| #9 | Event contract and append-only recording | #11; #13 for persistence |
| #7 | Standalone rep/audit UX | #11 and #9 event contract |
| #15 | HubSpot mapping, triggers, orchestration | #3, #4, #5, #6, #11, #13 |
| #14 | Production security and tenancy | #11, #13 |
| #16 | RevOps admin/review controls | #4, #7, #8, #9, #13 |
| #17 | HubSpot CRM embed | #7, #13, #14, #15 |
| #18 | Pilot design and metric dictionary | #11; coordinates with #9 |
| #19 | Read-only pilot metrics and exports | #9, #13, #18, and event producers |
| #20 | Pilot execution and final decision | #14, #15, #16, #17, #18, #19 |

### Ready and Done Gates

An issue is Ready when it has one primary owner and reviewer, explicit dependencies, stable shared contracts or fixtures, in/out-of-scope boundaries, and verifiable acceptance criteria. Keep at most one implementation issue in progress per developer.

An issue is Done when its acceptance criteria pass, relevant failure/safety cases are tested, `npm test` and `npm run build` pass, shared schemas/migrations and user-facing behavior are documented, ROADMAP status is updated after integration, and the other developer has reviewed the PR. A mocked or client-foundation path does not complete a production checklist item.
