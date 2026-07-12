import assert from "node:assert/strict";
import test from "node:test";
import { leads } from "../src/data/leads.ts";
import { defaultConfigVersion } from "../src/lib/config.ts";
import type { PilotEvent } from "../src/lib/instrumentation.ts";
import { RuntimeStore } from "../src/lib/persistence.ts";
import { createPilotReport, exportPilotReport } from "../src/lib/reporting.ts";

test("pilot reports reconcile tenant-scoped events, filters, duplicates, windows, and caveats", () => {
  const store = new RuntimeStore(":memory:");
  try {
    const packet = leads[0]!;
    store.saveTenant("tenant-1", "Pilot tenant");
    store.saveTenant("tenant-2", "Other tenant");
    store.saveConfigVersion("tenant-1", defaultConfigVersion);
    store.saveConfigVersion("tenant-2", defaultConfigVersion);
    store.saveEvaluation({ tenantId: "tenant-1", idempotencyKey: "pilot-eval", packet });
    store.registerPilotParticipant({
      tenantId: "tenant-1", repId: "rep-1", cohort: "contextai", teamId: "team-1",
      activeFrom: "2025-12-01T00:00:00.000Z"
    });
    store.recordEvaluationOwner({ tenantId: "tenant-1", evaluationId: packet.evaluation_id, repId: "rep-1", recordedAt: "2026-01-01T00:00:00.000Z" });

    const base = {
      tenantId: "tenant-1",
      requestId: packet.request_id,
      evaluationId: packet.evaluation_id,
      leadId: packet.lead_id,
      accountId: packet.account_id,
      actorType: "rep" as const,
      actorId: "actor-not-owner",
      scoreVersion: packet.score_version,
      configVersion: packet.score_version,
      promptVersion: "grounding-v1",
      evidenceRefs: [] as string[],
      retentionClass: "pilot_analytics_12_months" as const
    };
    const event = <T extends PilotEvent>(value: T) => store.recordEvent(value);
    event({ ...base, idempotencyKey: "run", occurredAt: "2026-01-01T09:00:00.000Z", name: "evaluation.run", data: { outcome: "complete", priorityScore: 94, priorityBand: "Hot" } });
    event({ ...base, idempotencyKey: "shown", occurredAt: "2026-01-01T09:01:00.000Z", name: "score.shown", data: { priorityScore: 94, priorityBand: "Hot", surface: "dashboard" } });
    event({ ...base, idempotencyKey: "view", occurredAt: "2026-01-01T09:02:00.000Z", name: "lead.viewed", data: { surface: "dashboard" } });
    event({ ...base, idempotencyKey: "accept", occurredAt: "2026-01-01T09:03:00.000Z", name: "recommendation.disposition", data: { disposition: "accepted", actionType: "email" } });
    event({ ...base, idempotencyKey: "override-late", occurredAt: "2026-01-01T10:03:00.000Z", name: "recommendation.disposition", data: { disposition: "overridden" } });
    event({ ...base, idempotencyKey: "action", occurredAt: "2026-01-01T10:02:00.000Z", name: "action.first_meaningful", data: { actionType: "email" } });
    event({ ...base, idempotencyKey: "meeting-reported", occurredAt: "2026-01-20T09:00:00.000Z", name: "meeting.attribution", data: { meetingId: "meeting-1", attribution: "rep_reported" } });
    event({ ...base, idempotencyKey: "meeting-crm", occurredAt: "2026-01-21T09:00:00.000Z", name: "meeting.attribution", data: { meetingId: "meeting-1", attribution: "crm_association" } });
    event({ ...base, idempotencyKey: "bad-fit", occurredAt: "2026-01-22T09:00:00.000Z", name: "outcome.attribution", data: { outcomeId: "outcome-1", outcomeType: "bad_fit", attribution: "crm_association" } });
    event({ ...base, evidenceRefs: ["gn-intent"], idempotencyKey: "weak", occurredAt: "2026-01-01T09:00:30.000Z", name: "source.contribution", data: { sourceType: "engagement", contribution: "supporting", weakSignal: true, hotMaking: true } });
    event({ ...base, retentionClass: "writeback_audit_24_months", idempotencyKey: "written", occurredAt: "2026-01-02T09:00:00.000Z", name: "writeback.outcome", data: { writebackId: "write-1", outcome: "Written" } });
    event({ ...base, retentionClass: "writeback_audit_24_months", idempotencyKey: "rollback", occurredAt: "2026-01-03T09:00:00.000Z", name: "writeback.rollback", data: { writebackId: "write-1", rollbackId: "rollback-1", fieldName: "contact_title" } });

    const report = createPilotReport(store.database, "tenant-1", { cohort: "contextai", teamId: "team-1", repId: "rep-1", band: "Hot" }, "2026-04-01T00:00:00.000Z");
    assert.equal(report.leads.processed, 1);
    assert.equal(report.leads.byBand.Hot, 1);
    assert.deepEqual(report.recommendations.accepted, { numerator: 1, denominator: 1, rate: 1 });
    assert.deepEqual(report.recommendations.overridden, { numerator: 0, denominator: 1, rate: 0 });
    assert.equal(report.researchTime.medianMinutes, 60);
    assert.deepEqual(report.meetings, { total: 1, enrolledReps: 1, perRep: 1, byRep: { "rep-1": 1 } });
    assert.deepEqual(report.conversion.Hot, { numerator: 1, denominator: 1, rate: 1 });
    assert.equal(report.hotFalsePositives.rate, 1);
    assert.equal(report.writebacks.rate, 1);
    assert.equal(report.writebacks.byOutcome.Written, 1);
    assert.equal(report.weakSignalContribution.rate, 1);
    assert.equal(report.dataQuality.duplicateDispositionEvents, 1);
    assert.equal(report.dataQuality.duplicateMeetingEvents, 1);
    assert.equal(createPilotReport(store.database, "tenant-2", {}, "2026-04-01T00:00:00.000Z").dataQuality.status, "no_data");
    assert.equal(createPilotReport(store.database, "tenant-1", { cohort: "control" }, "2026-04-01T00:00:00.000Z").leads.processed, 0);
    assert.equal(createPilotReport(store.database, "tenant-1", { configVersion: "wrong" }, "2026-04-01T00:00:00.000Z").leads.processed, 0);
    assert.equal(createPilotReport(store.database, "tenant-1", { scoreVersion: "wrong" }, "2026-04-01T00:00:00.000Z").leads.processed, 0);
    assert.equal(createPilotReport(store.database, "tenant-1", { source: "wrong" }, "2026-04-01T00:00:00.000Z").leads.processed, 0);
    assert.equal(createPilotReport(store.database, "tenant-1", { to: "2025-12-31T00:00:00.000Z" }, "2026-04-01T00:00:00.000Z").leads.processed, 0);

    const csv = exportPilotReport(report);
    assert.match(csv, /"pilot-v1","tenant-1","contextai"/);
    assert.match(csv, /"recommendation_acceptance","1","1","1"/);
  } finally {
    store.close();
  }
});

test("zero denominators and incomplete telemetry are unavailable rather than valid zeroes", () => {
  const store = new RuntimeStore(":memory:");
  try {
    store.saveTenant("tenant-1", "Pilot tenant");
    store.saveConfigVersion("tenant-1", defaultConfigVersion);
    store.saveEvaluation({ tenantId: "tenant-1", idempotencyKey: "missing-events", packet: leads[1]! });
    const report = createPilotReport(store.database, "tenant-1", {}, "2026-10-01T00:00:00.000Z");
    assert.equal(report.leads.processed, 0);
    assert.equal(report.recommendations.accepted.rate, null);
    assert.equal(report.dataQuality.status, "incomplete");
    assert.equal(report.dataQuality.missingEvaluationRuns, 1);
    assert.match(report.dataQuality.caveats.join(" "), /excluded, not counted as zero/i);
  } finally {
    store.close();
  }
});

test("pilot metric denominators honor index runs, active enrollment, attribution precedence, and outcome windows", () => {
  const store = new RuntimeStore(":memory:");
  try {
    const index = structuredClone(leads[0]!);
    const rescore = { ...structuredClone(index), evaluation_id: "eval-z-rescore", request_id: "request-rescore" };
    const outsideEnrollment = structuredClone(leads[1]!);
    store.saveTenant("tenant-1", "Pilot tenant");
    store.saveConfigVersion("tenant-1", defaultConfigVersion);
    store.saveEvaluation({ tenantId: "tenant-1", idempotencyKey: "index", packet: index });
    store.saveEvaluation({ tenantId: "tenant-1", idempotencyKey: "rescore", packet: rescore });
    store.saveEvaluation({ tenantId: "tenant-1", idempotencyKey: "outside", packet: outsideEnrollment });
    store.registerPilotParticipant({ tenantId: "tenant-1", repId: "rep-1", cohort: "contextai", teamId: "team-1", activeFrom: "2026-01-01T00:00:00.000Z" });
    store.registerPilotParticipant({ tenantId: "tenant-1", repId: "rep-2", cohort: "contextai", teamId: "team-1", activeFrom: "2026-08-01T00:00:00.000Z" });
    store.recordEvaluationOwner({ tenantId: "tenant-1", evaluationId: index.evaluation_id, repId: "rep-1" });
    store.recordEvaluationOwner({ tenantId: "tenant-1", evaluationId: rescore.evaluation_id, repId: "rep-1" });
    store.recordEvaluationOwner({ tenantId: "tenant-1", evaluationId: outsideEnrollment.evaluation_id, repId: "rep-2" });

    const base = (packet: typeof index) => ({
      tenantId: "tenant-1", requestId: packet.request_id, evaluationId: packet.evaluation_id,
      leadId: packet.lead_id, accountId: packet.account_id, actorType: "rep" as const, actorId: "actor-1",
      scoreVersion: packet.score_version, configVersion: packet.score_version, promptVersion: "grounding-v1",
      evidenceRefs: [] as string[], retentionClass: "pilot_analytics_12_months" as const
    });
    const event = <T extends PilotEvent>(value: T) => store.recordEvent(value);
    event({ ...base(index), idempotencyKey: "index-run", occurredAt: "2026-01-01T09:00:00.000Z", name: "evaluation.run", data: { outcome: "complete", priorityScore: 94, priorityBand: "Hot" } });
    event({ ...base(index), idempotencyKey: "index-run-retry", occurredAt: "2026-01-01T09:00:01.000Z", name: "evaluation.run", data: { outcome: "complete", priorityScore: 70, priorityBand: "Warm" } });
    event({ ...base(index), idempotencyKey: "index-shown", occurredAt: "2026-01-01T09:01:00.000Z", name: "score.shown", data: { priorityScore: 94, priorityBand: "Hot", surface: "dashboard" } });
    event({ ...base(index), idempotencyKey: "index-view", occurredAt: "2026-01-01T09:02:00.000Z", name: "lead.viewed", data: { surface: "dashboard" } });
    event({ ...base(index), idempotencyKey: "index-action", occurredAt: "2026-01-01T10:02:00.000Z", name: "action.first_meaningful", data: { actionType: "email" } });
    event({ ...base(index), idempotencyKey: "index-meeting", occurredAt: "2026-01-20T09:00:00.000Z", name: "meeting.attribution", data: { meetingId: "meeting-index", attribution: "crm_association" } });
    event({ ...base(index), idempotencyKey: "outcome-rep", occurredAt: "2026-01-20T09:00:00.000Z", name: "outcome.attribution", data: { outcomeId: "outcome-1", outcomeType: "bad_fit", attribution: "rep_reported" } });
    event({ ...base(index), idempotencyKey: "outcome-crm", occurredAt: "2026-01-21T09:00:00.000Z", name: "outcome.attribution", data: { outcomeId: "outcome-1", outcomeType: "opportunity_created", attribution: "crm_association" } });
    event({ ...base(index), retentionClass: "writeback_audit_24_months", idempotencyKey: "write-1", occurredAt: "2026-01-02T09:00:00.000Z", name: "writeback.outcome", data: { writebackId: "write-1", outcome: "Written", fieldName: "contact_title" } });
    event({ ...base(index), retentionClass: "writeback_audit_24_months", idempotencyKey: "write-1-retry", occurredAt: "2026-01-02T09:00:01.000Z", name: "writeback.outcome", data: { writebackId: "write-1", outcome: "Written", fieldName: "contact_title" } });
    event({ ...base(index), retentionClass: "writeback_audit_24_months", idempotencyKey: "rollback-1", occurredAt: "2026-01-03T09:00:00.000Z", name: "writeback.rollback", data: { writebackId: "write-1", rollbackId: "rollback-1", fieldName: "contact_title" } });
    event({ ...base(index), retentionClass: "writeback_audit_24_months", idempotencyKey: "write-2", occurredAt: "2026-01-02T09:00:00.000Z", name: "writeback.outcome", data: { writebackId: "write-2", outcome: "Written", fieldName: "contact_title" } });
    event({ ...base(index), retentionClass: "writeback_audit_24_months", idempotencyKey: "rollback-late", occurredAt: "2026-02-05T09:00:00.000Z", name: "writeback.rollback", data: { writebackId: "write-2", rollbackId: "rollback-2", fieldName: "contact_title" } });

    event({ ...base(rescore), idempotencyKey: "rescore-run", occurredAt: "2026-01-02T09:00:00.000Z", name: "evaluation.run", data: { outcome: "complete", priorityScore: 94, priorityBand: "Hot" } });
    event({ ...base(rescore), idempotencyKey: "rescore-view", occurredAt: "2026-01-02T09:01:00.000Z", name: "lead.viewed", data: { surface: "dashboard" } });
    event({ ...base(rescore), idempotencyKey: "rescore-action", occurredAt: "2026-01-02T09:06:00.000Z", name: "action.first_meaningful", data: { actionType: "call" } });
    event({ ...base(rescore), idempotencyKey: "rescore-meeting", occurredAt: "2026-01-25T09:00:00.000Z", name: "meeting.attribution", data: { meetingId: "meeting-rescore", attribution: "crm_association" } });
    event({ ...base(rescore), evidenceRefs: ["gn-intent"], idempotencyKey: "rescore-weak", occurredAt: "2026-01-02T09:00:01.000Z", name: "source.contribution", data: { sourceType: "engagement", contribution: "supporting", weakSignal: true, hotMaking: true } });
    event({ ...base(outsideEnrollment), idempotencyKey: "outside-run", occurredAt: "2026-01-03T09:00:00.000Z", name: "evaluation.run", data: { outcome: "complete", priorityScore: outsideEnrollment.priority_score, priorityBand: outsideEnrollment.priority_band } });

    const report = createPilotReport(store.database, "tenant-1", { cohort: "contextai" }, "2026-04-01T00:00:00.000Z");
    assert.equal(report.leads.processed, 2);
    assert.equal(report.leads.byBand.Hot, 2);
    assert.equal(report.leads.byBand.Warm, 0);
    assert.equal(report.researchTime.medianMinutes, 60);
    assert.equal(report.researchTime.eligibleViews, 1);
    assert.equal(report.meetings.total, 1);
    assert.equal(report.hotFalsePositives.rate, 0);
    assert.equal(report.writebacks.rate, 0.5);
    assert.equal(report.writebacks.byField.contact_title!.Written, 2);
    assert.equal(report.weakSignalContribution.rate, 0);
  } finally {
    store.close();
  }
});
