# v0 Pilot Baseline and Validation Plan

- Status: Approval-ready draft
- Owner: Product validation owner (name during Stage A)
- Reviewers: RevOps, engineering/analytics, and security/privacy during Stage A; pilot customer admin during Stage B
- Tracks: GitHub issue #18

This plan defines the v0 pilot before any rep sees a ContextAI recommendation. The PRD remains authoritative for product and safety requirements; `src/lib/instrumentation.ts` remains authoritative for event names and metric inputs. Issue #19 owns report implementation, and issue #20 owns pilot execution and the final decision.

## Approval stages

Issue #18 owns the reusable pilot design and closes after Stage A approval. Customer-specific setup and launch readiness belong to issue #20 and its dependencies in Stage B. Stage B does not delay approval of this design, but no cohort may be exposed until both stages pass.

### Stage A: issue #18 design approval

| Role | Named approver | Approval | Date |
| --- | --- | --- | --- |
| Product validation owner | TBD | Pending | TBD |
| RevOps reviewer | TBD | Pending | TBD |
| Engineering/analytics reviewer | TBD | Pending | TBD |
| Security/privacy reviewer | TBD | Pending | TBD |

- [ ] Product and RevOps approve the ICP, cohort design, metric dictionary, baselines, numeric targets, surveys, native-alternative gate, and decision rubric.
- [ ] Engineering/analytics confirms the #9 contract and named read-only sources can measure each definition without adding PII.
- [ ] Security/privacy approves the PII exclusions, retention rules, incident triggers, and stop actions.
- [ ] The named approvers and approval date are recorded in the table above.

### Stage B: customer launch gate

- [ ] The customer admin approves the data map and confirms that the customer matches the ICP and identifies the native or single-vendor control workflow.
- [ ] Cohort assignments, exclusions, score/config versions, source allowlists, and the email-open threshold are frozen.
- [ ] The pilot registry maps opaque rep IDs, cohort, active dates, and index-evaluation ownership; meeting events use source booking time and reconcile to the CRM.
- [ ] Production producers emit the applicable #9 events for treatment and shadow-control flows; dry-run reconciliation has no unexplained event loss.
- [ ] #14's authentication, least privilege, tenant isolation, retention, revoke, incident, and role controls pass their launch gates.
- [ ] Live writeback remains disabled until allowlist, audit, idempotency, rollback, and customer approval checks pass.
- [ ] #19 reproduces the approved metric definitions from read-only data without adding PII or changing producer behavior.
- [ ] RevOps completes a rollback drill and records the incident contacts authorized to pause the pilot.

## Pilot population and design

### ICP

Use one HubSpot-first B2B pilot customer with fragmented CRM, enrichment, and engagement data; a RevOps/SalesOps owner; and visible rep research or CRM-quality pain. Exclude teams with fewer than five participating reps, no CRM system of record, a sufficient single-platform native workflow, or a requirement for autonomous outreach.

### Size and duration

- 1-2 RevOps admins.
- 5-20 SDRs/AEs.
- At least 500 eligible contacts, counted once by their index evaluation.
- Eight weeks of exposure, preceded by at least ten business days of baseline capture.
- Meeting and outcome results mature for 60 days after each contact's index evaluation. The final outcome read therefore occurs after exposure ends; the eight-week exposure is not mislabeled as a 60-day outcome window.

### Cohorts

Assign reps, not individual contacts, to avoid workflow contamination:

- **Control:** existing workflow. ContextAI creates a read-only shadow evaluation to link measurement events, but it must not emit `score.shown`, display a recommendation, or write to CRM.
- **ContextAI:** the same eligible workflow with the score, reason, hook, and approved controls visible. Writeback begins in dry-run and is enabled separately only after its launch gate passes.

Match and randomize reps within blocks using role, inbound/outbound motion, territory, segment, historical eligible volume, lead source mix, company-size mix, lifecycle-stage mix, and baseline meeting rate. Keep assignments fixed and analyze reassigned or departed reps by original cohort. Aim for a 1:1 split; neither arm may contain fewer than 40% of eligible contacts.

The index evaluation is the first eligible evaluation for a contact during exposure. Contact-level outcome metrics use the index evaluation so repeated scoring does not multiply the denominator. Recommendation-disposition metrics remain evaluation-level because each displayed recommendation is a separate decision.

Before baseline capture, freeze a customer-approved pilot registry keyed only by opaque IDs. It maps each participating rep to cohort, matching strata, and active dates, and maps each index evaluation to the CRM owner snapshot. Event `actorId` identifies the event actor and must not be assumed to be the assigned rep. For `meeting.attribution`, `occurredAt` is the source meeting-booking timestamp, not ingestion time; the CRM extract supplies meeting creation/association details and the registry supplies active rep-weeks.

### Eligibility and exclusions

Include assigned, open HubSpot contacts in the agreed inbound, outbound-assisted, or hybrid motion. Record exclusions before analysis. Exclude test/internal contacts, pre-existing meetings or opportunities for the measured outcome, ineligible lifecycle stages, and contacts outside the agreed territory or segment. Ambiguous associations, duplicate risk, conflicting domains, and `Needs Manual Review` remain visible safety outcomes but do not enter numeric-band conversion denominators. A nullable `account_id` alone is not an exclusion.

## Numeric target decisions for approval

| Measure | Proposed decision |
| --- | --- |
| Research/triage time | Retain the PRD target: at least 40% median reduction from the treatment reps' measured baseline; 60% is the stretch result. Require a favorable change versus control and adequate action coverage. |
| Recommendation acceptance | Retain the PRD target: at least 60% of evaluations with a recorded disposition are accepted. Require adequate disposition coverage. |
| Meetings | Retain the roadmap's provisional 10% directional lift versus control over a fully matured 60-day window. Treat it as directional, not a standalone go/no-go gate at this sample size. |
| Hot false positives | Retain a 25% relative reduction from the customer's measured pre-launch priority baseline and require the ContextAI rate to be below that baseline. |
| Core-field completeness | Define the roadmap's 20% lift as a relative lift in complete-record rate from baseline, with a favorable change versus control. |
| Bad writebacks | Retain under 1% rolled back. Any rollback pauses live writeback for investigation; with fewer than 100 Written IDs, report the exact count and do not claim precision from the rate. |
| Email-open-driven Hot records | Retain the initial default below 10%; the RevOps admin may approve a stricter threshold before exposure. |
| Widget latency | Retain under 2.5 seconds cached and under 10 seconds fresh as a #17 operational SLO, not a product-outcome metric. |
| Rep trust | Retain the roadmap gate: at least 70% of responding treatment reps select Agree or Strongly agree that the reason/hook is trustworthy enough to act on. Require at least 70% survey response coverage. |

The unsourced "10-15 minutes per prospect" figure is not a baseline or target.

The research-time result is inconclusive unless at least 70% of eligible viewed contacts in each cohort have a qualifying action and cohort coverage differs by no more than 10 percentage points. The acceptance result is inconclusive unless at least 70% of treatment `score.shown` evaluations have a disposition. An inconclusive primary metric cannot support Proceed.

## Metric dictionary

`First meaningful action` means the earliest observed call, email, sequence enrollment, manual enrichment, nurture, or disqualification after the first qualifying `lead.viewed` for an evaluation. ContextAI records these actions; it does not execute them. A research-time interval is observed only when the action occurs after the view and within 24 hours. Records without an action are censored, never assigned zero minutes, and their coverage is reported.

| Metric | Planned source and query | Denominator and window | Baseline and target | Owner |
| --- | --- | --- | --- | --- |
| Research time | For each index evaluation, subtract the first `lead.viewed.occurredAt` from the earliest later `action.first_meaningful.occurredAt`; take the cohort median. Use CRM-record open as the start in both arms, not `score.shown`. | Index evaluations with a valid view and qualifying action within 24 hours; report all eligible views and censored records. Baseline: ten-business-day pre-period. Exposure: weekly and full eight weeks. | Treatment reps' measured pre-period; at least 40% median reduction, 60% stretch, favorable change versus control. | Product analytics owns query; engineering owns producers; RevOps validates workflow timestamps. |
| Recommendation acceptance and override | Select the first `recommendation.disposition` by time for each evaluation. Count `accepted` and `overridden` separately. Missing dispositions are missing, not `ignored`. Also report evaluations with a disposition divided by `score.shown` evaluations. | Distinct treatment evaluations with any disposition, within 24 hours of `score.shown`; segment by score/config/prompt version. | No native equivalent is forced. Acceptance target is at least 60%; override is diagnostic and reviewed by action type and coded qualitative feedback. | Product analytics; RevOps reviews override themes. |
| Meetings per rep | Join the index evaluation to the frozen owner/cohort registry. Deduplicate `meeting.attribution.data.meetingId`, use its source booking-time `occurredAt`, prefer `crm_association`, and use `rep_reported` only when CRM association is unavailable and confirmed once. Divide attributed meetings by enrolled reps; report active rep-weeks from registry dates beside it. | Enrolled reps and meetings attributed within 60 days of an index evaluation. Exclude meetings created before the index evaluation. | Matured historical 60-day baseline and concurrent control; 10% directional treatment lift. | RevOps owns CRM/registry mapping; product analytics owns query. |
| Hot/Warm meeting conversion | Count matured index evaluations in each band with at least one deduplicated `meeting.attribution`; divide by matured index evaluations in that band. Use `score.shown` for treatment and the invisible `evaluation.run` result for shadow control. | Distinct eligible Hot or Warm index evaluations with a full 60-day window. Report Hot and Warm separately and combined. | Concurrent shadow control, with historical source/segment rates as context; directional lift, not a separately powered gate. | Product analytics; engineering verifies shadow bands never reach control users. |
| Hot false-positive rate | Count distinct Hot treatment evaluations later linked to `outcome.attribution` of `bad_fit` or `disqualified`; divide by distinct Hot `score.shown` evaluations. Deduplicate to the first qualifying outcome and retain attribution basis. | Hot treatment evaluations with a full 60-day outcome window. Incomplete attribution is reported separately. | Customer's pre-launch native priority/Hot definition, documented before exposure; 25% relative reduction and below baseline. Shadow-control `evaluation.run` is a separate diagnostic because control has no truthful `score.shown`. | Product analytics; RevOps approves native-status mapping. |
| Core-field completeness | At index and end snapshots, count a field only when it is one of `coreFields`, nonblank, source-backed, and no older than 90 days. A complete record has all ten qualifying fields. Report complete-record rate and field-level coverage. | Eligible index contacts. The ten fields are company domain/name/size band, industry, revenue band, headquarters region, LinkedIn company URL, contact title/seniority/department. | Baseline CRM/evidence snapshot; 20% relative lift in treatment complete-record rate and favorable change versus control. | RevOps owns field/source map; product analytics owns read-only derivation. |
| Bad writeback rate | Count distinct `writeback.outcome` IDs with outcome `Written` that later have `writeback.rollback`; divide by distinct Written IDs. `writeback.edit` is diagnostic, not automatically bad. Never use `writeback_plan` as an outcome. | Written IDs through 30 days after each write; report fields and exact rollback count. | Zero live writes during baseline. Target below 1%; any rollback triggers the component stop below. | RevOps owns adjudication; engineering owns audit linkage; product analytics owns query. |
| Email-open primary-driver rate | Count distinct Hot `evaluation.run` evaluations having a primary `source.contribution` with `weakSignal=true` whose `evidenceRefs` resolve to normalized engagement evidence with email opens; divide by distinct Hot evaluation runs. Other weak-signal types are reported separately and do not enter this PRD metric. Failed sources contribute no evidence. | Hot evaluations during exposure, segmented by score/config version. The preflight must prove every counted contribution resolves to its evaluation-owned evidence. | Shadow baseline under the frozen configuration; below admin-approved threshold, initially 10%. | Product analytics; RevOps approves threshold and investigates source mix. |

All queries are read-only. They must segment version changes rather than blend them, treat incomplete telemetry as missing rather than zero, use UTC event ordering, and expose numerator, denominator, missingness, and attribution basis. #19 may implement these queries but may not redefine them.

## Baseline instruments

| Baseline | Instrument |
| --- | --- |
| Research time | Run the same `lead.viewed` to `action.first_meaningful` capture for participating reps during at least ten business days before exposure. Do not substitute an industry benchmark. |
| Systems checked | On three sampled workdays in baseline and weeks 4 and 8, ask reps for only the count of distinct systems checked before first action (`0`, `1`, `2`, `3`, `4+`). Keep the customer-approved system inventory separately; analytics stores the count only. |
| Conversion | Extract a fully matured historical 60-day cohort using the same eligibility, source, meeting-deduplication, and attribution rules. Report by lead source and incumbent priority band. |
| Completeness | Take a read-only CRM/evidence snapshot immediately before exposure using the ten-field rule above. Preserve source and freshness metadata. |
| Trust | Baseline five-point survey on the incumbent score/recommendation: understanding, trustworthiness enough to act, and need to re-check another system. |
| Manual enrichment | Over the ten-business-day pre-period, count distinct eligible contacts with at least one manual enrichment edit in CRM field history and divide by eligible acted contacts. If field history is unavailable, use the same three sampled workdays as the systems diary and label the rate survey-derived. Report first-action `manual_enrichment` separately because it does not measure enrichment performed later in a workflow. |
| Duplicates and bad fit | Freeze the customer's duplicate flags and bad-fit/disqualified status mapping before extraction. Duplicate rate is distinct eligible contacts flagged suspected/confirmed duplicate at index divided by eligible contacts. Bad-fit rate is distinct eligible contacts attributed `bad_fit` or `disqualified` within 60 days divided by eligible contacts with a matured window. Never infer duplicate state from a nullable account or merge records automatically. |

## Attribution, quality, and analysis rules

### Attribution

- Use CRM association before rep report. A rep-reported outcome needs one coded confirmation and cannot overwrite a conflicting CRM association without RevOps review.
- Deduplicate outcomes by opaque meeting/outcome ID. One meeting may count once for a contact and once for its assigned rep, never once per repeated evaluation.
- Use the cohort assignment and lead owner at the index evaluation. Report transfers separately.
- Exclude outcomes that predate the index evaluation. Freeze attribution 60 days after that evaluation.
- Keep intent and engagement separate. Email opens are weak engagement, never intent, and cannot support Hot by themselves.

### Data-quality checks

Before exposure, reconcile a dry run from producer to read-only query for every stable event used above. During the pilot, check daily for:

- valid tenant/request/evaluation/lead links, opaque actors, evidence ownership, score/config/prompt versions, and retention class;
- registry-to-index-owner joins, rep active dates, meeting source booking timestamps, and CRM attribution reconciliation;
- duplicate idempotency keys, invalid chronology, clock skew, and outcomes preceding their index evaluation;
- cohort leakage, control `score.shown` events, control writebacks, and assignment imbalance;
- event-recorder failures, missing required events, missing attribution, and survey response coverage;
- completeness evidence freshness and source backing;
- writeback outcomes without matching audits or rollbacks without a prior `Written` outcome.

Pause new exposure when more than 5% of required event attempts are unexplained or unrecoverable for two consecutive daily checks. No prohibited PII event is tolerated.

### Minimum-sample caveats

Five to twenty reps and 500 contacts are enough for a directional pilot, not a general causal claim. Report 95% confidence intervals and absolute counts, but do not turn a non-significant result into proof of no effect. Cluster results by rep, disclose cohort imbalance and missingness, and avoid subgroup claims with fewer than 30 eligible contacts. Meeting results remain preliminary until every included contact has 60 days to mature. A bad-writeback percentage with fewer than 100 Written IDs is descriptive only.

### Analysis template

Every result row must contain: metric version, cohort, eligibility window, numerator/value, denominator, missing/censored count, baseline, absolute change, relative change, control-adjusted change where applicable, 95% interval, score/config/prompt versions, attribution basis, and caveat. The final packet also includes safety incidents, writeback adjudications, survey response, rep/admin themes, and the native-alternative comparison.

## Survey and interview cadence

All closed-ended statements use the same scale: `1 Strongly disagree`, `2 Disagree`, `3 Neither agree nor disagree`, `4 Agree`, `5 Strongly agree`, and `Not applicable`. Exclude `Not applicable` from the metric denominator and report it with missing responses.

### Common comparison instrument

Administer at baseline to all reps using the named incumbent workflow, and at week 8 using the incumbent for control and ContextAI for treatment. Replace `[workflow]` with that name:

1. "I understand why [workflow] prioritizes the records I work."
2. "I trust [workflow]'s prioritization enough to act on it."
3. "[workflow] lets me decide what to do without checking another system."

### Weekly treatment instrument

1. "I understand why ContextAI assigned priorities to the records I worked this week."
2. "The ContextAI reason and hook are trustworthy enough for me to act on."
3. "ContextAI reduced the number of systems I needed to check before acting this week."

Ask these optional qualitative prompts without prospect details:

1. "What, if anything, made you trust or distrust a ContextAI reason or hook this week?"
2. "What did you still need to verify in another system before acting?"
3. After an override: "What made you override the recommendation?"

### RevOps admin instrument

Administer at weeks 4 and 8:

1. "I can explain and reproduce a ContextAI score from the approved configuration and evidence."
2. "ContextAI provides useful cross-vendor context that our incumbent workflow does not."
3. "ContextAI's audit trail is sufficient to review score inputs and writeback outcomes."

Ask: "Where is ContextAI materially more or less auditable than the incumbent workflow?"

### Cadence and scoring

- **Baseline:** common comparison instrument before assignment is revealed.
- **Weekly:** treatment instrument and optional prompts.
- **Week 4:** treatment instrument, RevOps admin instrument, and midpoint interviews covering friction, overrides, weak signals, and cohort leakage. Apply only safety fixes during the frozen pilot; analyze material product changes as a new version.
- **Week 8:** common comparison instrument for both cohorts, treatment instrument for treatment reps, admin instrument, and end interviews.
- **After 60-day maturation:** final outcome review with RevOps.

The trust gate uses week 8 treatment responses to this exact statement: **"The ContextAI reason and hook are trustworthy enough for me to act on."** Scores 4 and 5 count as positive. The denominator is treatment respondents with a valid 1-5 answer; response coverage must reach 70% of enrolled treatment reps. Survey data uses opaque participant IDs, and no prospect data belongs in free text.

## Native and single-vendor comparison

Before exposure, the customer admin records the control product, enabled features, source coverage, scoring ownership, score explainability, writeback behavior, and per-rep workflow. Evaluate both workflows against the same tasks and cohort rules:

1. Time and systems required before first action.
2. Meeting conversion, false positives, completeness, and trust.
3. Whether at least two customer-approved source categories outside the CRM can contribute with visible provenance.
4. Whether RevOps can reproduce a displayed score from the frozen deterministic configuration and audit every contributing source and writeback outcome.

The honest gate fails if the incumbent provides equivalent cross-vendor coverage and score auditability, or if ContextAI cannot show a favorable research-time change without worse trust, false positives, or CRM safety. A failed honest gate leads to Narrow or Stop even when adoption is high.

## Privacy, retention, and stop rules

### Data boundary

- Pilot events use opaque IDs and categorical values. They exclude names, email addresses, phone numbers, postal/precise locations, IP addresses, message/email bodies, notes, and raw provider payloads; recursive prohibited-key and email-shaped-value rejection stays enabled.
- Read only customer-approved CRM fields needed for scoring, evidence, matching, or outcome attribution. Do not ingest full inboxes, full email bodies, sensitive personal attributes, or data for shared-model training.
- Persisted lead packets can contain identity data, so they require #14's tenant isolation, access control, encryption, deletion, and customer-approved field/retention policy before pilot use.
- Avoid raw source storage. Pilot analytics and coded survey data retain for at most 12 months or the shorter customer policy. Writeback audits retain for 24 months or the customer's governing policy. Customer revocation stops collection and begins the approved deletion workflow.

### Incident and component stops

| Trigger | Immediate action |
| --- | --- |
| Cross-tenant access, prohibited/sensitive data exposure, credential compromise, or prospect-facing automation | Stop all exposure and processing, revoke affected credentials, preserve the minimal audit trail, and enter the approved incident process. Resume only with security and customer approval. |
| Unauthorized field, routing/lifecycle/owner change, or any confirmed bad writeback/rollback | Disable live writeback, notify RevOps, inspect the complete batch, and rollback where safe. Recommendation display may resume only if the incident is isolated from scoring/display and the approvers agree. |
| Nondeterministic score, missing version, weak opens alone producing Hot, or evidence/claim mismatch | Stop score display for the affected version; keep records in manual review until corrected and revalidated. |
| Control recommendation exposure, control writeback, or material cohort leakage | Pause the affected cohort, preserve assignment, and decide whether contaminated records or reps must be excluded. |
| Telemetry loss above the data-quality threshold | Pause new exposure; never backfill guessed events or count missing outcomes as zero. |

## Decision rubric

- **Proceed:** no unresolved safety stop; primary-metric coverage is adequate; research time reaches at least 40%; acceptance reaches at least 60%; completeness improves at least 20%; Hot false positives fall below baseline; email-open-driven Hot records stay below the approved threshold; bad writebacks remain below 1%; trust reaches at least 70%; and the native-alternative honest gate passes. Meeting lift supports the decision after maturation but is not required to clear a low-powered pilot alone.
- **Narrow:** safety passes and the honest gate is supported, but success is concentrated in a prespecified role, segment, source mix, or workflow. Continue only for that ICP and validate again.
- **Pivot:** safety passes and vendor-neutral/auditable value remains credible, but one or more primary workflow targets miss for a specific, correctable reason. Freeze the failed version and approve a new plan before re-exposure.
- **Stop:** any critical safety issue remains unresolved; both research-time and acceptance targets miss without a credible measurement fault; RevOps cannot reproduce/audit scoring; CRM harm is unacceptable; or the native/single-vendor honest gate fails.

Final approval belongs to the named Product, RevOps, Security, and customer owners. A dashboard or report does not approve the pilot by itself.
