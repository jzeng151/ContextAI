# Pilot Telemetry Contract

`src/lib/instrumentation.ts` is the source of truth for pilot events. Producers import its types and `createEventRecorder`; aggregation and reporting remain owned by issue #19.

## Recording

Create one recorder at the application boundary, provide an operational failure observer, and pass the resulting `recordEvent(event): void` to producers:

```ts
const recordEvent = createEventRecorder(store, observeRecordingFailure);
recordEvent(event);
```

The recorder validates and appends an event. A storage or validation failure is sent to the observer and never thrown into deterministic scoring or writeback. Reusing an idempotency key with the same event is a no-op; reusing it for different data is an observable failure. Fixtures make `eventId`, `idempotencyKey`, and `occurredAt` explicit for deterministic tests.

Every event links to one tenant, request, evaluation, lead, nullable account, opaque actor, score version, config version, timestamp, retention class, and zero or more evidence IDs. Score display and recommendation disposition also require a prompt version. Evidence IDs must belong to the linked evaluation. Writeback edit and rollback events must link to a prior `Written` writeback outcome.

## Stable Events

| Event | Required event data |
| --- | --- |
| `evaluation.run` | outcome, priority score, priority band |
| `score.shown` | priority score, priority band, surface |
| `lead.viewed` | surface |
| `action.first_meaningful` | action type |
| `recommendation.disposition` | accepted, ignored, or overridden; action type when known |
| `source.contribution` | source type, primary/supporting contribution, weak-signal flag, Hot-making flag, evidence IDs |
| `writeback.outcome` | writeback ID, outcome, field when applicable |
| `writeback.edit` | linked writeback ID and field |
| `writeback.rollback` | linked writeback ID, rollback ID, and field |
| `meeting.attribution` | meeting ID and attribution basis |
| `outcome.attribution` | outcome ID, outcome type, and attribution basis |

`action.first_meaningful` is the first observed call, email, sequence enrollment, manual enrichment, nurture, or disqualification after a lead view. ContextAI records these actions; it does not execute them.

For `source.contribution`, `hotMaking` is true only for a Hot evaluation when deterministic scoring under the same score/config version produces a non-Hot band after removing the referenced contribution. It is false otherwise. A weak email-open contribution may be counted as Hot-making only when its evidence references resolve to normalized open evidence and that same-version counterfactual passes.

## Privacy and Retention

Events use opaque IDs, categorical values, and evidence references. They exclude names, email addresses, phone numbers, postal or precise locations, IP addresses, message/email bodies, notes, and raw provider payloads. The runtime rejects prohibited keys and email-shaped values recursively.

Pilot analytics events use `pilot_analytics_12_months`. Writeback outcome, edit, and rollback events use `writeback_audit_24_months`. Issue #14 owns production retention enforcement and customer overrides.

## Metric Dictionary Inputs

These measurable definitions are inputs to issue #18, which owns final pilot approval, windows, cohorts, and thresholds:

- **Accepted / overridden:** numerator is distinct evaluations whose first disposition is the matching value; denominator is distinct evaluations with a disposition.
- **First meaningful action:** earliest `action.first_meaningful` after `lead.viewed` for the evaluation.
- **Hot false positive:** distinct eligible contacts whose Hot index evaluation is later attributed `bad_fit` or `disqualified`; denominator is distinct eligible contacts with a Hot `score.shown` for their index evaluation.
- **Core field:** one of the exported `coreFields` with current, source-backed evidence no older than 90 days.
- **Bad writeback:** distinct Written writeback IDs later rolled back; denominator is distinct Written writeback outcomes. An edit alone is diagnostic, not automatically bad.
- **Weak-signal primary driver:** distinct Hot index evaluations with a weak email-open contribution marked `hotMaking`; denominator is distinct Hot index evaluation runs.

Meeting and other outcome rates use their attribution events and the cohort/window approved by issue #18. Reporting queries do not belong in producers or this recording boundary.
