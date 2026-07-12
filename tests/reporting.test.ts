import assert from "node:assert/strict";
import test from "node:test";
import { leads } from "../src/data/leads.ts";
import { defaultConfigVersion } from "../src/lib/config.ts";
import type { PilotEvent } from "../src/lib/instrumentation.ts";
import { RuntimeStore } from "../src/lib/persistence.ts";
import { createPilotReport, exportPilotReport } from "../src/lib/reporting.ts";

const admin = (tenantId: string) => ({ requestId: `request-${tenantId}`, tenantId, actorId: "admin-1", role: "revops_admin" as const });
const day = 24 * 60 * 60 * 1000;
const csvRow = (csv: string, metric: string) => {
  const line = csv.split("\n").find((row) => row.includes(`"${metric}"`));
  assert.ok(line);
  return [...line.matchAll(/"((?:[^"]|"")*)"/g)].map(([, value]) => value!.replaceAll('""', '"'));
};

test("pilot reports reconcile tenant-scoped events, filters, duplicates, windows, and caveats", () => {
  const store = new RuntimeStore(":memory:");
  try {
    const packet = leads[0]!;
    store.saveTenant("tenant-1", "Pilot tenant");
    store.saveTenant("tenant-2", "Other tenant");
    store.saveConfigVersion(admin("tenant-1"), defaultConfigVersion);
    store.saveConfigVersion(admin("tenant-1"), { ...defaultConfigVersion, id: "wrong", status: "draft" });
    store.saveConfigVersion(admin("tenant-2"), defaultConfigVersion);
    store.saveEvaluation({ tenantId: "tenant-1", idempotencyKey: "pilot-eval", packet });
    store.database.prepare("UPDATE evaluation_runs SET completed_at = ? WHERE evaluation_id = ?").run("2026-01-01T09:00:00.000Z", packet.evaluation_id);
    store.registerPilotParticipant({
      tenantId: "tenant-1", repId: "rep-1", cohort: "contextai", teamId: "team-1",
      activeFrom: "2025-12-01T00:00:00.000Z"
    });
    assert.throws(() => store.database.prepare("INSERT OR REPLACE INTO pilot_participants SELECT * FROM pilot_participants WHERE tenant_id = 'tenant-1' AND rep_id = 'rep-1'").run(), /frozen/i);
    assert.equal(store.endPilotParticipation("tenant-1", "rep-1", "2026-02-01T00:00:00.000Z"), true);
    assert.throws(() => store.endPilotParticipation("tenant-1", "rep-1", "2026-03-01T00:00:00.000Z"), /frozen/i);
    assert.throws(() => store.database.prepare("UPDATE pilot_participants SET cohort = 'control' WHERE tenant_id = 'tenant-1' AND rep_id = 'rep-1'").run(), /frozen/i);
    store.recordEvaluationOwner({ tenantId: "tenant-1", evaluationId: packet.evaluation_id, repId: "rep-1", evaluationKind: "exposure_index", recordedAt: "2026-01-01T00:00:00.000Z" });
    assert.throws(() => store.database.prepare("INSERT OR REPLACE INTO pilot_evaluation_owners SELECT * FROM pilot_evaluation_owners WHERE tenant_id = 'tenant-1' AND evaluation_id = ?").run(packet.evaluation_id), /append-only/i);

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
    event({ ...base, promptVersion: "grounding-v2", idempotencyKey: "shown-v2", occurredAt: "2026-01-01T11:00:00.000Z", name: "score.shown", data: { priorityScore: 94, priorityBand: "Hot", surface: "dashboard" } });
    event({ ...base, promptVersion: "grounding-v2", idempotencyKey: "override-v2", occurredAt: "2026-01-01T11:01:00.000Z", name: "recommendation.disposition", data: { disposition: "overridden" } });
    event({ ...base, idempotencyKey: "action", occurredAt: "2026-01-01T10:02:00.000Z", name: "action.first_meaningful", data: { actionType: "email" } });
    event({ ...base, idempotencyKey: "meeting-reported", occurredAt: "2026-01-20T09:00:00.000Z", name: "meeting.attribution", data: { meetingId: "meeting-1", attribution: "rep_reported" } });
    event({ ...base, idempotencyKey: "meeting-crm", occurredAt: "2026-01-21T09:00:00.000Z", name: "meeting.attribution", data: { meetingId: "meeting-1", attribution: "crm_association" } });
    event({ ...base, idempotencyKey: "bad-fit", occurredAt: "2026-01-22T09:00:00.000Z", name: "outcome.attribution", data: { outcomeId: "outcome-1", outcomeType: "bad_fit", attribution: "crm_association" } });
    event({ ...base, evidenceRefs: ["gn-intent"], idempotencyKey: "weak", occurredAt: "2026-01-01T09:00:30.000Z", name: "source.contribution", data: { sourceType: "engagement", contribution: "supporting", weakSignal: true, hotMaking: true } });
    event({ ...base, configVersion: "wrong", idempotencyKey: "wrong-config-view", occurredAt: "2026-01-01T09:02:30.000Z", name: "lead.viewed", data: { surface: "dashboard" } });
    event({ ...base, retentionClass: "writeback_audit_24_months", idempotencyKey: "written", occurredAt: "2026-01-02T09:00:00.000Z", name: "writeback.outcome", data: { writebackId: "write-1", outcome: "Written" } });
    event({ ...base, retentionClass: "writeback_audit_24_months", idempotencyKey: "rollback", occurredAt: "2026-01-03T09:00:00.000Z", name: "writeback.rollback", data: { writebackId: "write-1", rollbackId: "rollback-1", fieldName: "contact_title" } });

    const report = createPilotReport(store.database, "tenant-1", { cohort: "contextai", teamId: "team-1", repId: "rep-1", band: "Hot" }, "2026-04-01T00:00:00.000Z");
    assert.equal(report.leads.processed, 1);
    assert.equal(report.leads.byBand.Hot, 1);
    assert.deepEqual(report.recommendations.accepted, { numerator: 1, denominator: 1, rate: 1 });
    assert.deepEqual(report.recommendations.overridden, { numerator: 0, denominator: 1, rate: 0 });
    assert.equal(report.researchTime.medianMinutes, 60);
    assert.deepEqual(report.meetings, { total: 1, enrolledReps: 1, activeRepWeeks: 62 / 7, perRep: 1, perActiveRepWeek: 7 / 62, byRep: { "rep-1": 1 } });
    assert.deepEqual(report.conversion.Hot, { numerator: 1, denominator: 1, rate: 1 });
    assert.equal(report.hotFalsePositives.rate, 1);
    assert.equal(report.writebacks.rate, 1);
    assert.equal(report.writebacks.byOutcome.Written, 1);
    assert.equal(report.weakSignalContribution.rate, 0);
    assert.equal(report.dataQuality.duplicateDispositionEvents, 2);
    assert.equal(report.dataQuality.duplicateMeetingEvents, 1);
    const promptV2 = createPilotReport(store.database, "tenant-1", { promptVersion: "grounding-v2" }, "2026-04-01T00:00:00.000Z");
    assert.equal(promptV2.recommendations.accepted.rate, 0);
    assert.equal(promptV2.recommendations.overridden.rate, 1);
    assert.match(exportPilotReport(promptV2), /"prompt_version"/);
    assert.match(exportPilotReport(promptV2), /"grounding-v2"/);
    assert.match(exportPilotReport(report).split("\n")[0]!, /"team_id","rep_id","score_version","config_version"/);
    assert.equal(createPilotReport(store.database, "tenant-2", {}, "2026-04-01T00:00:00.000Z").dataQuality.status, "no_data");
    assert.equal(createPilotReport(store.database, "tenant-1", { cohort: "control" }, "2026-04-01T00:00:00.000Z").leads.processed, 0);
    const wrongConfig = createPilotReport(store.database, "tenant-1", { configVersion: "wrong" }, "2026-04-01T00:00:00.000Z");
    assert.equal(wrongConfig.leads.processed, 0);
    assert.equal(wrongConfig.crmCompleteness.denominator, 0);
    assert.equal(createPilotReport(store.database, "tenant-1", { scoreVersion: "wrong" }, "2026-04-01T00:00:00.000Z").leads.processed, 0);
    assert.equal(createPilotReport(store.database, "tenant-1", { source: "wrong" }, "2026-04-01T00:00:00.000Z").leads.processed, 0);
    assert.equal(createPilotReport(store.database, "tenant-1", { to: "2025-12-31T00:00:00.000Z" }, "2026-04-01T00:00:00.000Z").leads.processed, 0);

    const csv = exportPilotReport(report);
    assert.match(csv, /"pilot-v1","tenant-1","contextai"/);
    assert.match(csv, /"recommendation_acceptance","1","1","1"/);
    assert.match(csv, /"meetings_per_active_rep_week"/);
    assert.match(csv, /"crm_field_index:company_domain"/);
    assert.match(csv, /"crm_field_end:company_domain"/);
    const promptCsv = exportPilotReport(promptV2);
    assert.equal(csvRow(promptCsv, "leads_processed")[7], "all");
    assert.equal(csvRow(promptCsv, "recommendation_acceptance")[7], "grounding-v2");
    assert.equal(csvRow(promptCsv, "hot_conversion")[7], "grounding-v2");
    assert.equal(csvRow(promptCsv, "hot_false_positive")[7], "grounding-v2");
  } finally {
    store.close();
  }
});

test("zero denominators and incomplete telemetry are unavailable rather than valid zeroes", () => {
  const store = new RuntimeStore(":memory:");
  try {
    store.saveTenant("tenant-1", "Pilot tenant");
    store.saveConfigVersion(admin("tenant-1"), defaultConfigVersion);
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
    store.saveConfigVersion(admin("tenant-1"), defaultConfigVersion);
    store.saveEvaluation({ tenantId: "tenant-1", idempotencyKey: "index", packet: index });
    store.saveEvaluation({ tenantId: "tenant-1", idempotencyKey: "rescore", packet: rescore });
    store.saveEvaluation({ tenantId: "tenant-1", idempotencyKey: "outside", packet: outsideEnrollment });
    store.database.prepare("UPDATE evaluation_runs SET completed_at = ? WHERE evaluation_id = ?").run("2026-01-01T09:00:00.000Z", index.evaluation_id);
    store.database.prepare("UPDATE evaluation_runs SET completed_at = ? WHERE evaluation_id = ?").run("2026-01-02T09:00:00.000Z", rescore.evaluation_id);
    store.database.prepare("UPDATE evaluation_runs SET completed_at = ? WHERE evaluation_id = ?").run("2026-01-03T09:00:00.000Z", outsideEnrollment.evaluation_id);
    store.registerPilotParticipant({ tenantId: "tenant-1", repId: "rep-1", cohort: "contextai", teamId: "team-1", activeFrom: "2026-01-01T00:00:00.000Z" });
    store.registerPilotParticipant({ tenantId: "tenant-1", repId: "rep-2", cohort: "contextai", teamId: "team-1", activeFrom: "2026-08-01T00:00:00.000Z" });
    store.recordEvaluationOwner({ tenantId: "tenant-1", evaluationId: index.evaluation_id, repId: "rep-1", evaluationKind: "exposure_index" });
    store.recordEvaluationOwner({ tenantId: "tenant-1", evaluationId: rescore.evaluation_id, repId: "rep-1", evaluationKind: "rescore" });
    store.recordEvaluationOwner({ tenantId: "tenant-1", evaluationId: outsideEnrollment.evaluation_id, repId: "rep-2", evaluationKind: "exposure_index" });

    const base = (packet: typeof index) => ({
      tenantId: "tenant-1", requestId: packet.request_id, evaluationId: packet.evaluation_id,
      leadId: packet.lead_id, accountId: packet.account_id, actorType: "rep" as const, actorId: "actor-1",
      scoreVersion: packet.score_version, configVersion: packet.score_version, promptVersion: "grounding-v1",
      evidenceRefs: [] as string[], retentionClass: "pilot_analytics_12_months" as const
    });
    const event = <T extends PilotEvent>(value: T) => store.recordEvent(value);
    event({ ...base(index), idempotencyKey: "index-run", occurredAt: "2026-01-01T08:00:00.000Z", name: "evaluation.run", data: { outcome: "complete", priorityScore: 94, priorityBand: "Hot" } });
    event({ ...base(index), idempotencyKey: "index-run-retry", occurredAt: "2026-01-01T04:30:00-05:00", name: "evaluation.run", data: { outcome: "complete", priorityScore: 70, priorityBand: "Warm" } });
    event({ ...base(index), idempotencyKey: "index-shown", occurredAt: "2026-01-01T09:01:00.000Z", name: "score.shown", data: { priorityScore: 94, priorityBand: "Hot", surface: "dashboard" } });
    event({ ...base(index), idempotencyKey: "index-view", occurredAt: "2026-01-01T09:02:00.000Z", name: "lead.viewed", data: { surface: "dashboard" } });
    event({ ...base(index), idempotencyKey: "index-action", occurredAt: "2026-01-01T10:02:00.000Z", name: "action.first_meaningful", data: { actionType: "email" } });
    event({ ...base(index), idempotencyKey: "index-meeting", occurredAt: "2026-01-20T09:00:00.000Z", name: "meeting.attribution", data: { meetingId: "meeting-index", attribution: "crm_association" } });
    event({ ...base(index), idempotencyKey: "outcome-rep", occurredAt: "2026-01-20T09:00:00.000Z", name: "outcome.attribution", data: { outcomeId: "outcome-1", outcomeType: "bad_fit", attribution: "rep_reported" } });
    event({ ...base(index), idempotencyKey: "outcome-crm", occurredAt: "2026-01-21T09:00:00.000Z", name: "outcome.attribution", data: { outcomeId: "outcome-1", outcomeType: "opportunity_created", attribution: "crm_association" } });
    event({ ...base(index), idempotencyKey: "outcome-later-bad-fit", occurredAt: "2026-01-22T09:00:00.000Z", name: "outcome.attribution", data: { outcomeId: "outcome-2", outcomeType: "bad_fit", attribution: "crm_association" } });
    event({ ...base(index), retentionClass: "writeback_audit_24_months", idempotencyKey: "write-1", occurredAt: "2026-01-02T09:00:00.000Z", name: "writeback.outcome", data: { writebackId: "write-1", outcome: "Written", fieldName: "contact_title" } });
    event({ ...base(index), retentionClass: "writeback_audit_24_months", idempotencyKey: "write-1-retry", occurredAt: "2026-01-02T09:00:01.000Z", name: "writeback.outcome", data: { writebackId: "write-1", outcome: "Written", fieldName: "contact_title" } });
    event({ ...base(index), retentionClass: "writeback_audit_24_months", idempotencyKey: "rollback-1", occurredAt: "2026-01-03T09:00:00.000Z", name: "writeback.rollback", data: { writebackId: "write-1", rollbackId: "rollback-1", fieldName: "contact_title" } });
    event({ ...base(index), retentionClass: "writeback_audit_24_months", idempotencyKey: "write-2", occurredAt: "2026-01-02T09:00:00.000Z", name: "writeback.outcome", data: { writebackId: "write-2", outcome: "Written", fieldName: "contact_title" } });
    event({ ...base(index), retentionClass: "writeback_audit_24_months", idempotencyKey: "rollback-late", occurredAt: "2026-02-05T09:00:00.000Z", name: "writeback.rollback", data: { writebackId: "write-2", rollbackId: "rollback-2", fieldName: "contact_title" } });
    event({ ...base(index), retentionClass: "writeback_audit_24_months", idempotencyKey: "write-pending", occurredAt: "2026-03-20T09:00:00.000Z", name: "writeback.outcome", data: { writebackId: "write-pending", outcome: "Written", fieldName: "contact_title" } });

    event({ ...base(rescore), idempotencyKey: "rescore-run", occurredAt: "2026-01-02T09:00:00.000Z", name: "evaluation.run", data: { outcome: "complete", priorityScore: 94, priorityBand: "Hot" } });
    event({ ...base(rescore), idempotencyKey: "rescore-view", occurredAt: "2026-01-02T09:01:00.000Z", name: "lead.viewed", data: { surface: "dashboard" } });
    event({ ...base(rescore), idempotencyKey: "rescore-action", occurredAt: "2026-01-02T09:06:00.000Z", name: "action.first_meaningful", data: { actionType: "call" } });
    event({ ...base(rescore), idempotencyKey: "rescore-meeting", occurredAt: "2026-01-25T09:00:00.000Z", name: "meeting.attribution", data: { meetingId: "meeting-rescore", attribution: "crm_association" } });
    event({ ...base(rescore), evidenceRefs: ["gn-intent"], idempotencyKey: "rescore-weak", occurredAt: "2026-01-02T09:00:01.000Z", name: "source.contribution", data: { sourceType: "engagement", contribution: "supporting", weakSignal: true, hotMaking: true } });
    event({ ...base(outsideEnrollment), idempotencyKey: "outside-run", occurredAt: "2026-01-03T09:00:00.000Z", name: "evaluation.run", data: { outcome: "complete", priorityScore: outsideEnrollment.priority_score, priorityBand: outsideEnrollment.priority_band } });

    const report = createPilotReport(store.database, "tenant-1", { cohort: "contextai" }, "2026-04-01T00:00:00.000Z");
    assert.equal(report.leads.processed, 1);
    assert.equal(report.leads.byBand.Hot, 1);
    assert.equal(report.leads.byBand.Warm, 0);
    assert.equal(report.researchTime.medianMinutes, 60);
    assert.equal(report.researchTime.eligibleViews, 1);
    assert.equal(report.meetings.total, 1);
    assert.equal(report.meetings.enrolledReps, 1);
    assert.equal(report.meetings.activeRepWeeks, 90 / 7);
    assert.equal(report.meetings.perActiveRepWeek, 7 / 90);
    assert.equal(report.hotFalsePositives.rate, 0);
    assert.equal(report.writebacks.rate, 0.5);
    assert.equal(report.writebacks.written, 2);
    assert.equal(report.writebacks.byField.contact_title!.Written, 3);
    assert.equal(report.weakSignalContribution.rate, 0);
    assert.match(report.dataQuality.caveats.join(" "), /30-day rollback window/i);
    assert.match(report.dataQuality.caveats.join(" "), /2 matured Written ID\(s\).*descriptive only.*exact rollback count is 1/i);
  } finally {
    store.close();
  }
});

test("band filters cannot promote a later rescore to the contact index", () => {
  const store = new RuntimeStore(":memory:");
  try {
    const coldIndex = { ...structuredClone(leads[1]!), evaluation_id: "eval-band-a-index", request_id: "request-band-index", lead_id: "lead-band" };
    const hotRescore = { ...structuredClone(leads[0]!), evaluation_id: "eval-band-z-rescore", request_id: "request-band-rescore", lead_id: "lead-band" };
    const baseline = { ...structuredClone(leads[1]!), evaluation_id: "eval-band-baseline", request_id: "request-band-baseline", lead_id: "lead-band" };
    store.saveTenant("tenant-1", "Pilot tenant");
    store.saveConfigVersion(admin("tenant-1"), defaultConfigVersion);
    store.saveEvaluation({ tenantId: "tenant-1", idempotencyKey: "band-baseline", packet: baseline });
    store.saveEvaluation({ tenantId: "tenant-1", idempotencyKey: "band-index", packet: coldIndex });
    store.saveEvaluation({ tenantId: "tenant-1", idempotencyKey: "band-rescore", packet: hotRescore });
    store.registerPilotParticipant({ tenantId: "tenant-1", repId: "rep-1", cohort: "contextai", teamId: "team-1", activeFrom: "2025-12-01T00:00:00.000Z" });
    store.recordEvaluationOwner({ tenantId: "tenant-1", evaluationId: baseline.evaluation_id, repId: "rep-1", evaluationKind: "baseline_anchor" });
    store.recordEvaluationOwner({ tenantId: "tenant-1", evaluationId: coldIndex.evaluation_id, repId: "rep-1", evaluationKind: "exposure_index" });
    store.recordEvaluationOwner({ tenantId: "tenant-1", evaluationId: hotRescore.evaluation_id, repId: "rep-1", evaluationKind: "rescore" });
    store.database.prepare("UPDATE evaluation_runs SET completed_at = ? WHERE evaluation_id = ?").run("2025-12-15T09:00:00.000Z", baseline.evaluation_id);
    store.database.prepare("UPDATE evaluation_runs SET completed_at = ? WHERE evaluation_id = ?").run("2026-01-01T09:00:00.000Z", coldIndex.evaluation_id);
    store.database.prepare("UPDATE evaluation_runs SET completed_at = ? WHERE evaluation_id = ?").run("2026-01-02T09:00:00.000Z", hotRescore.evaluation_id);
    const event = <T extends PilotEvent>(value: T) => store.recordEvent(value);
    const base = (packet: typeof coldIndex) => ({
      tenantId: "tenant-1", requestId: packet.request_id, evaluationId: packet.evaluation_id, leadId: packet.lead_id,
      accountId: packet.account_id, actorType: "system" as const, actorId: "system-1", scoreVersion: packet.score_version,
      configVersion: packet.score_version, evidenceRefs: [] as string[], retentionClass: "pilot_analytics_12_months" as const
    });
    event({ ...base(coldIndex), idempotencyKey: "cold-run", occurredAt: "2026-01-01T09:00:00.000Z", name: "evaluation.run", data: { outcome: "complete", priorityScore: coldIndex.priority_score, priorityBand: "Cold" } });
    event({ ...base(hotRescore), idempotencyKey: "hot-run", occurredAt: "2026-01-02T09:00:00.000Z", name: "evaluation.run", data: { outcome: "complete", priorityScore: 94, priorityBand: "Hot" } });
    event({ ...base(hotRescore), evidenceRefs: ["gn-intent"], idempotencyKey: "hot-weak", occurredAt: "2026-01-02T09:00:01.000Z", name: "source.contribution", data: { sourceType: "engagement", contribution: "supporting", weakSignal: true, hotMaking: true } });

    const report = createPilotReport(store.database, "tenant-1", { band: "Hot" }, "2026-04-01T00:00:00.000Z");
    assert.equal(report.leads.processed, 0);
    assert.equal(report.weakSignalContribution.denominator, 0);
    assert.equal(report.weakSignalContribution.rate, null);
    assert.equal(report.conversion.Hot.denominator, 0);
    assert.equal(createPilotReport(store.database, "tenant-1", { from: "2026-01-02T00:00:00.000Z" }, "2026-04-01T00:00:00.000Z").leads.processed, 0);
  } finally {
    store.close();
  }
});

test("conversion uses displayed treatment bands per contact and outcomes stay on index evaluations", () => {
  const store = new RuntimeStore(":memory:");
  try {
    const indexes = [0, 1, 2].map((number) => ({
      ...structuredClone(leads[0]!),
      evaluation_id: `eval-conversion-${number}`,
      request_id: `request-conversion-${number}`,
      lead_id: `lead-conversion-${number}`
    }));
    const rescore = { ...structuredClone(indexes[0]!), evaluation_id: "eval-conversion-rescore", request_id: "request-conversion-rescore" };
    store.saveTenant("tenant-1", "Pilot tenant");
    store.saveConfigVersion(admin("tenant-1"), defaultConfigVersion);
    store.registerPilotParticipant({ tenantId: "tenant-1", repId: "rep-1", cohort: "contextai", teamId: "team-1", activeFrom: "2026-01-01T00:00:00.000Z" });
    for (const [number, packet] of indexes.entries()) {
      store.saveEvaluation({ tenantId: "tenant-1", idempotencyKey: `conversion-${number}`, packet });
      store.database.prepare("UPDATE evaluation_runs SET completed_at = ? WHERE evaluation_id = ?").run(`2026-01-0${number + 1}T09:00:00.000Z`, packet.evaluation_id);
      store.recordEvaluationOwner({ tenantId: "tenant-1", evaluationId: packet.evaluation_id, repId: "rep-1", evaluationKind: "exposure_index" });
    }
    store.saveEvaluation({ tenantId: "tenant-1", idempotencyKey: "conversion-rescore", packet: rescore });
    store.database.prepare("UPDATE evaluation_runs SET completed_at = ? WHERE evaluation_id = ?").run("2026-01-02T09:00:00.000Z", rescore.evaluation_id);
    store.recordEvaluationOwner({ tenantId: "tenant-1", evaluationId: rescore.evaluation_id, repId: "rep-1", evaluationKind: "rescore" });
    const base = (packet: typeof indexes[number]) => ({
      tenantId: "tenant-1", requestId: packet.request_id, evaluationId: packet.evaluation_id, leadId: packet.lead_id,
      accountId: packet.account_id, actorType: "system" as const, actorId: "system-1", scoreVersion: packet.score_version,
      configVersion: packet.score_version, promptVersion: "grounding-v1", evidenceRefs: [] as string[], retentionClass: "pilot_analytics_12_months" as const
    });
    const event = <T extends PilotEvent>(value: T) => store.recordEvent(value);
    for (const [number, packet] of indexes.entries()) {
      event({ ...base(packet), idempotencyKey: `conversion-run-${number}`, occurredAt: `2026-01-0${number + 1}T09:00:00.000Z`, name: "evaluation.run", data: { outcome: "complete", priorityScore: 94, priorityBand: "Hot" } });
      if (number < 2) {
        event({ ...base(packet), idempotencyKey: `conversion-shown-${number}`, occurredAt: `2026-01-0${number + 1}T09:01:00.000Z`, name: "score.shown", data: { priorityScore: 94, priorityBand: "Hot", surface: "dashboard" } });
        event({ ...base(packet), idempotencyKey: `conversion-meeting-${number}`, occurredAt: "2026-01-20T09:00:00.000Z", name: "meeting.attribution", data: { meetingId: "shared-meeting", attribution: "crm_association" } });
      }
    }
    event({ ...base(indexes[0]!), idempotencyKey: "index-bad-fit", occurredAt: "2026-01-10T09:00:00.000Z", name: "outcome.attribution", data: { outcomeId: "shared-outcome", outcomeType: "bad_fit", attribution: "rep_reported" } });
    event({ ...base(rescore), idempotencyKey: "rescore-opportunity", occurredAt: "2026-01-11T09:00:00.000Z", name: "outcome.attribution", data: { outcomeId: "shared-outcome", outcomeType: "opportunity_created", attribution: "crm_association" } });

    const report = createPilotReport(store.database, "tenant-1", {}, "2026-04-01T00:00:00.000Z");
    assert.deepEqual(report.conversion.Hot, { numerator: 2, denominator: 2, rate: 1 });
    assert.equal(report.hotFalsePositives.numerator, 1);
    assert.equal(report.hotFalsePositives.denominator, 2);
  } finally {
    store.close();
  }
});

test("contact indexes preserve their original cohort and ownerless meetings stay out of per-rep rates", () => {
  const store = new RuntimeStore(":memory:");
  try {
    const controlIndex = { ...structuredClone(leads[0]!), evaluation_id: "eval-transfer-a-control", request_id: "request-transfer-control", lead_id: "lead-transfer" };
    const contextRescore = { ...structuredClone(leads[0]!), evaluation_id: "eval-transfer-z-context", request_id: "request-transfer-context", lead_id: "lead-transfer" };
    contextRescore.crm_context.evidence.push({ ...contextRescore.crm_context.evidence[0]!, evidence_id: "transfer-department", field_name: "contact_department", field_value: "Operations", field_values: { contact_department: "Operations" }, source_updated_at: contextRescore.evaluation_timestamp });
    const ownerless = { ...structuredClone(leads[1]!), evaluation_id: "eval-ownerless", request_id: "request-ownerless", lead_id: "lead-ownerless" };
    store.saveTenant("tenant-1", "Pilot tenant");
    store.saveConfigVersion(admin("tenant-1"), defaultConfigVersion);
    for (const [idempotencyKey, packet] of [["control", controlIndex], ["context", contextRescore], ["ownerless", ownerless]] as const) {
      store.saveEvaluation({ tenantId: "tenant-1", idempotencyKey, packet });
    }
    store.database.prepare("UPDATE evaluation_runs SET completed_at = ? WHERE evaluation_id = ?").run("2026-01-01T09:00:00.000Z", controlIndex.evaluation_id);
    store.database.prepare("UPDATE evaluation_runs SET completed_at = ? WHERE evaluation_id = ?").run("2026-01-02T09:00:00.000Z", contextRescore.evaluation_id);
    store.database.prepare("UPDATE evaluation_runs SET completed_at = ? WHERE evaluation_id = ?").run("2026-01-01T09:00:00.000Z", ownerless.evaluation_id);
    store.registerPilotParticipant({ tenantId: "tenant-1", repId: "rep-control", cohort: "control", teamId: "team-1", activeFrom: "2026-01-01T00:00:00.000Z" });
    store.registerPilotParticipant({ tenantId: "tenant-1", repId: "rep-context", cohort: "contextai", teamId: "team-1", activeFrom: "2026-01-01T00:00:00.000Z" });
    store.recordEvaluationOwner({ tenantId: "tenant-1", evaluationId: controlIndex.evaluation_id, repId: "rep-control", evaluationKind: "exposure_index" });
    store.recordEvaluationOwner({ tenantId: "tenant-1", evaluationId: contextRescore.evaluation_id, repId: "rep-context", evaluationKind: "rescore" });
    const base = (packet: typeof controlIndex) => ({
      tenantId: "tenant-1", requestId: packet.request_id, evaluationId: packet.evaluation_id, leadId: packet.lead_id,
      accountId: packet.account_id, actorType: "system" as const, actorId: "system-1", scoreVersion: packet.score_version,
      configVersion: packet.score_version, promptVersion: "grounding-v1", evidenceRefs: [] as string[], retentionClass: "pilot_analytics_12_months" as const
    });
    const event = <T extends PilotEvent>(value: T) => store.recordEvent(value);
    event({ ...base(controlIndex), idempotencyKey: "control-run", occurredAt: "2026-01-01T09:00:00.000Z", name: "evaluation.run", data: { outcome: "complete", priorityScore: 94, priorityBand: "Hot" } });
    event({ ...base(controlIndex), idempotencyKey: "control-shown", occurredAt: "2026-01-01T09:01:00.000Z", name: "score.shown", data: { priorityScore: 94, priorityBand: "Hot", surface: "dashboard" } });
    store.appendAuditRecord(admin("tenant-1"), {
      auditId: "control-write", evaluationId: controlIndex.evaluation_id, requestId: controlIndex.request_id,
      crmObjectType: "contact", crmObjectId: controlIndex.lead_id, fieldName: "contact_title", sourceName: "HubSpot",
      sourceRef: controlIndex.lead_id, sourceUpdatedAt: controlIndex.evaluation_timestamp, confidence: "High",
      outcome: "Written", reason: "Live write", scoreVersion: controlIndex.score_version, recordedAt: "2026-01-01T09:02:00.000Z"
    });
    event({ ...base(contextRescore), idempotencyKey: "context-run", occurredAt: "2026-01-02T09:00:00.000Z", name: "evaluation.run", data: { outcome: "complete", priorityScore: 94, priorityBand: "Hot" } });
    event({ ...base(ownerless), idempotencyKey: "ownerless-run", occurredAt: "2026-01-01T09:00:00.000Z", name: "evaluation.run", data: { outcome: "complete", priorityScore: ownerless.priority_score, priorityBand: ownerless.priority_band } });
    event({ ...base(ownerless), idempotencyKey: "ownerless-shown", occurredAt: "2026-01-01T09:01:00.000Z", name: "score.shown", data: { priorityScore: ownerless.priority_score, priorityBand: ownerless.priority_band, surface: "dashboard" } });
    event({ ...base(ownerless), idempotencyKey: "ownerless-accepted", occurredAt: "2026-01-01T09:02:00.000Z", name: "recommendation.disposition", data: { disposition: "accepted" } });
    event({ ...base(ownerless), idempotencyKey: "ownerless-meeting", occurredAt: "2026-01-20T09:00:00.000Z", name: "meeting.attribution", data: { meetingId: "meeting-ownerless", attribution: "crm_association" } });

    const contextReport = createPilotReport(store.database, "tenant-1", { cohort: "contextai" }, "2026-04-01T00:00:00.000Z");
    assert.equal(contextReport.leads.processed, 0);
    assert.equal(contextReport.crmCompleteness.denominator, 0);
    const controlReport = createPilotReport(store.database, "tenant-1", { cohort: "control" }, "2026-04-01T00:00:00.000Z");
    assert.equal(controlReport.crmCompleteness.fieldCoverage.contact_department, 1);
    const report = createPilotReport(store.database, "tenant-1", {}, "2026-04-01T00:00:00.000Z");
    assert.equal(report.leads.processed, 2);
    assert.equal(report.meetings.total, 0);
    assert.equal(report.meetings.perRep, 0);
    assert.equal(report.dataQuality.controlRecommendationExposure, 1);
    assert.equal(report.dataQuality.controlWritebackExposure, 1);
    assert.equal(report.writebacks.byOutcome.Written, 0);
    assert.equal(report.recommendations.coverage.denominator, 0);
    assert.match(report.dataQuality.caveats.join(" "), /cohort leakage/i);
    assert.match(report.dataQuality.caveats.join(" "), /lack a frozen owner snapshot/i);
  } finally {
    store.close();
  }
});

test("CRM completeness compares index and end snapshots without future-dated evidence", () => {
  const store = new RuntimeStore(":memory:");
  try {
    const index = { ...structuredClone(leads[0]!), evaluation_id: "eval-completeness-index", request_id: "request-completeness-index", lead_id: "lead-completeness" };
    const source = index.crm_context.evidence[0]!;
    index.crm_context.evidence.push({
      ...source, evidence_id: "future-seniority", field_name: "contact_seniority", field_value: "VP",
      field_values: { contact_seniority: "VP" }, source_updated_at: "2027-01-01T00:00:00.000Z"
    });
    const end = { ...structuredClone(index), evaluation_id: "eval-completeness-end", request_id: "request-completeness-end" };
    end.crm_context.evidence.push({
      ...source, evidence_id: "end-department", field_name: "contact_department", field_value: "Operations",
      field_values: { contact_department: "Operations" }, source_updated_at: end.evaluation_timestamp
    });
    store.saveTenant("tenant-1", "Pilot tenant");
    store.saveConfigVersion(admin("tenant-1"), defaultConfigVersion);
    store.saveEvaluation({ tenantId: "tenant-1", idempotencyKey: "completeness-index", packet: index });
    store.saveEvaluation({ tenantId: "tenant-1", idempotencyKey: "completeness-end", packet: end });
    store.registerPilotParticipant({ tenantId: "tenant-1", repId: "rep-1", cohort: "contextai", teamId: "team-1", activeFrom: "2026-01-01T00:00:00.000Z" });
    store.recordEvaluationOwner({ tenantId: "tenant-1", evaluationId: index.evaluation_id, repId: "rep-1", evaluationKind: "exposure_index" });
    store.recordEvaluationOwner({ tenantId: "tenant-1", evaluationId: end.evaluation_id, repId: "rep-1", evaluationKind: "rescore" });
    store.database.prepare("UPDATE evaluation_runs SET completed_at = ? WHERE evaluation_id = ?").run("2026-01-01T09:00:00.000Z", index.evaluation_id);
    store.database.prepare("UPDATE evaluation_runs SET completed_at = ? WHERE evaluation_id = ?").run("2026-02-01T09:00:00.000Z", end.evaluation_id);
    store.recordEvent({
      tenantId: "tenant-1", requestId: index.request_id, evaluationId: index.evaluation_id, leadId: index.lead_id,
      accountId: index.account_id, actorType: "system", actorId: "system-1", scoreVersion: index.score_version,
      configVersion: index.score_version, evidenceRefs: [], retentionClass: "pilot_analytics_12_months",
      idempotencyKey: "completeness-run", occurredAt: "2026-01-01T09:00:00.000Z", name: "evaluation.run",
      data: { outcome: "complete", priorityScore: index.priority_score, priorityBand: index.priority_band }
    });

    const report = createPilotReport(store.database, "tenant-1", {}, "2026-04-01T00:00:00.000Z");
    assert.equal(report.crmCompleteness.fieldCoverage.company_domain, 1);
    assert.equal(report.crmCompleteness.fieldCoverage.company_name, 1);
    assert.equal(report.crmCompleteness.fieldCoverage.contact_title, 1);
    assert.equal(report.crmCompleteness.index.fieldCoverage.contact_department, 0);
    assert.equal(report.crmCompleteness.fieldCoverage.contact_department, 1);
    assert.equal(report.crmCompleteness.index.fieldCoverage.contact_seniority, 0);
    assert.equal(report.crmCompleteness.fieldCoverage.contact_seniority, 0);
  } finally {
    store.close();
  }
});

test("default report window excludes future evaluations and events", () => {
  const store = new RuntimeStore(":memory:");
  try {
    const current = { ...structuredClone(leads[0]!), evaluation_id: "eval-current", request_id: "request-current", lead_id: "lead-current" };
    const future = { ...structuredClone(leads[0]!), evaluation_id: "eval-future", request_id: "request-future", lead_id: "lead-future" };
    store.saveTenant("tenant-1", "Pilot tenant");
    store.saveConfigVersion(admin("tenant-1"), defaultConfigVersion);
    store.registerPilotParticipant({ tenantId: "tenant-1", repId: "rep-1", cohort: "contextai", teamId: "team-1", activeFrom: "2026-01-01T00:00:00.000Z" });
    for (const packet of [current, future]) {
      store.saveEvaluation({ tenantId: "tenant-1", idempotencyKey: packet.evaluation_id, packet });
      const occurredAt = packet === current ? packet.evaluation_timestamp : "2027-01-01T09:00:00.000Z";
      store.database.prepare("UPDATE evaluation_runs SET completed_at = ? WHERE evaluation_id = ?").run(occurredAt, packet.evaluation_id);
      store.recordEvaluationOwner({ tenantId: "tenant-1", evaluationId: packet.evaluation_id, repId: "rep-1", evaluationKind: "exposure_index" });
      store.recordEvent({
        tenantId: "tenant-1", requestId: packet.request_id, evaluationId: packet.evaluation_id, leadId: packet.lead_id,
        accountId: packet.account_id, actorType: "system", actorId: "system-1", scoreVersion: packet.score_version,
        configVersion: packet.score_version, evidenceRefs: [], retentionClass: "pilot_analytics_12_months",
        idempotencyKey: `${packet.evaluation_id}:run`, occurredAt, name: "evaluation.run",
        data: { outcome: "complete", priorityScore: packet.priority_score, priorityBand: packet.priority_band }
      });
    }
    store.recordEvent({
      tenantId: "tenant-1", requestId: current.request_id, evaluationId: current.evaluation_id, leadId: current.lead_id,
      accountId: current.account_id, actorType: "system", actorId: "system-1", scoreVersion: current.score_version,
      configVersion: current.score_version, promptVersion: "grounding-v1", evidenceRefs: [], retentionClass: "pilot_analytics_12_months",
      idempotencyKey: "future-shown", occurredAt: "2027-01-01T09:01:00.000Z", name: "score.shown",
      data: { priorityScore: current.priority_score!, priorityBand: current.priority_band, surface: "dashboard" }
    });
    store.appendAuditRecord(admin("tenant-1"), {
      auditId: "future-write", evaluationId: current.evaluation_id, requestId: current.request_id,
      crmObjectType: "contact", crmObjectId: current.lead_id, fieldName: "contact_title", sourceName: "HubSpot",
      sourceRef: current.lead_id, sourceUpdatedAt: current.evaluation_timestamp, confidence: "High",
      outcome: "Written", reason: "Future write", scoreVersion: current.score_version, recordedAt: "2027-01-01T09:02:00.000Z"
    });
    const invalid = store.database.prepare(`
      INSERT INTO events (event_id, tenant_id, evaluation_id, request_id, event_type, payload_json, occurred_at, idempotency_key, retention_class)
      VALUES (?, 'tenant-1', ?, ?, 'evaluation.run', '{', ?, ?, 'pilot_analytics_12_months')
    `);
    invalid.run("invalid-current", current.evaluation_id, current.request_id, current.evaluation_timestamp, "invalid-current");
    invalid.run("invalid-past", current.evaluation_id, current.request_id, "2026-06-01T00:00:00.000Z", "invalid-past");
    invalid.run("invalid-future", current.evaluation_id, current.request_id, "2027-01-01T09:03:00.000Z", "invalid-future");

    const report = createPilotReport(store.database, "tenant-1", { from: "2026-07-01T00:00:00.000Z" }, "2026-10-01T00:00:00.000Z");
    assert.equal(report.leads.processed, 1);
    assert.equal(report.recommendations.coverage.denominator, 0);
    assert.equal(report.writebacks.byOutcome.Written, 0);
    assert.equal(report.dataQuality.invalidEvents, 1);
    assert.equal(createPilotReport(store.database, "tenant-1", { repId: "other" }, "2026-10-01T00:00:00.000Z").dataQuality.invalidEvents, 0);
    const historical = createPilotReport(store.database, "tenant-1", { to: "2026-07-15T00:00:00.000Z" }, "2026-10-01T00:00:00.000Z");
    assert.match(historical.metadata.caveats.join(" "), /without a complete 60-day maturation window/i);
  } finally {
    store.close();
  }
});

test("live writeback audits and rollback links feed rollback metrics", () => {
  const store = new RuntimeStore(":memory:");
  try {
    const packet = { ...structuredClone(leads[0]!), evaluation_id: "eval-live-audit", request_id: "request-live-audit", lead_id: "lead-live-audit" };
    const now = Date.now();
    const originalAt = new Date(now - day).toISOString();
    const generatedAt = new Date(now + 40 * day).toISOString();
    store.saveTenant("tenant-1", "Pilot tenant");
    store.saveConfigVersion(admin("tenant-1"), defaultConfigVersion);
    store.saveEvaluation({ tenantId: "tenant-1", idempotencyKey: "live-audit", packet });
    store.registerPilotParticipant({ tenantId: "tenant-1", repId: "rep-1", cohort: "contextai", teamId: "team-1", activeFrom: "2026-01-01T00:00:00.000Z" });
    store.recordEvaluationOwner({ tenantId: "tenant-1", evaluationId: packet.evaluation_id, repId: "rep-1", evaluationKind: "exposure_index" });
    store.recordEvent({
      tenantId: "tenant-1", requestId: packet.request_id, evaluationId: packet.evaluation_id, leadId: packet.lead_id,
      accountId: packet.account_id, actorType: "system", actorId: "system-1", scoreVersion: packet.score_version,
      configVersion: packet.score_version, evidenceRefs: [], retentionClass: "pilot_analytics_12_months",
      idempotencyKey: "live-audit-run", occurredAt: originalAt, name: "evaluation.run",
      data: { outcome: "complete", priorityScore: packet.priority_score, priorityBand: packet.priority_band }
    });
    const identity = { ...admin("tenant-1"), requestId: packet.request_id };
    const audit = {
      evaluationId: packet.evaluation_id, requestId: packet.request_id, crmObjectType: "contact", crmObjectId: packet.lead_id,
      fieldName: "contact_title", sourceName: "Provider", sourceRef: "record-1", sourceUpdatedAt: packet.evaluation_timestamp,
      confidence: "High", outcome: "Written", reason: "Live write", scoreVersion: packet.score_version
    };
    store.appendAuditRecord(identity, { ...audit, auditId: "live-write", recordedAt: originalAt });
    store.appendAuditRecord(identity, { ...audit, auditId: "rollback:live-write", reason: "Rollback of live-write" });
    store.appendRollbackLink("rollback:live-write", "tenant-1", packet.evaluation_id, "live-write", "rollback:live-write");
    store.appendAuditRecord(identity, { ...audit, auditId: "pending:stuck-write", outcome: "Pending", reason: "Reserved before live CRM write." });

    const report = createPilotReport(store.database, "tenant-1", {}, generatedAt);
    assert.equal(report.writebacks.written, 1);
    assert.equal(report.writebacks.rolledBack, 1);
    assert.equal(report.writebacks.rate, 1);
    assert.ok(report.metadata.caveats.some((caveat) => caveat.includes("1 live writeback reservation")));
  } finally {
    store.close();
  }
});

test("purged evaluations are excluded and only open-only evidence counts as weak-signal contribution", () => {
  const store = new RuntimeStore(":memory:");
  try {
    const weak = structuredClone(leads.find(({ lead_id }) => lead_id === "weak-opens")!);
    const warm = { ...structuredClone(weak), evaluation_id: "eval-warm-weak", request_id: "request-warm-weak", lead_id: "lead-warm-weak" };
    const purged = { ...structuredClone(leads[1]!), evaluation_id: "eval-purged", request_id: "request-purged", lead_id: "lead-purged" };
    store.saveTenant("tenant-1", "Pilot tenant");
    store.saveConfigVersion(admin("tenant-1"), defaultConfigVersion);
    store.saveEvaluation({ tenantId: "tenant-1", idempotencyKey: "weak", packet: weak });
    store.saveEvaluation({ tenantId: "tenant-1", idempotencyKey: "warm", packet: warm });
    store.saveEvaluation({ tenantId: "tenant-1", idempotencyKey: "purged", packet: purged, retentionAfter: "2026-01-02T00:00:00.000Z" });
    store.database.prepare("UPDATE evaluation_runs SET completed_at = ? WHERE evaluation_id = ?").run("2026-01-01T09:00:00.000Z", weak.evaluation_id);
    store.database.prepare("UPDATE evaluation_runs SET completed_at = ? WHERE evaluation_id = ?").run("2026-01-01T09:00:00.000Z", warm.evaluation_id);
    store.registerPilotParticipant({ tenantId: "tenant-1", repId: "rep-1", cohort: "contextai", teamId: "team-1", activeFrom: "2026-01-01T00:00:00.000Z" });
    store.recordEvaluationOwner({ tenantId: "tenant-1", evaluationId: weak.evaluation_id, repId: "rep-1", evaluationKind: "exposure_index" });
    store.recordEvaluationOwner({ tenantId: "tenant-1", evaluationId: warm.evaluation_id, repId: "rep-1", evaluationKind: "exposure_index" });
    const base = {
      tenantId: "tenant-1", requestId: weak.request_id, evaluationId: weak.evaluation_id, leadId: weak.lead_id,
      accountId: weak.account_id, actorType: "system" as const, actorId: "system-1", scoreVersion: weak.score_version,
      configVersion: weak.score_version, evidenceRefs: [] as string[], retentionClass: "pilot_analytics_12_months" as const
    };
    store.recordEvent({ ...base, idempotencyKey: "weak-run", occurredAt: "2026-01-01T09:00:00.000Z", name: "evaluation.run", data: { outcome: "complete", priorityScore: 90, priorityBand: "Hot" } });
    store.recordEvent({ ...base, evidenceRefs: ["wo-intent"], idempotencyKey: "weak-open", occurredAt: "2026-01-01T09:01:00.000Z", name: "source.contribution", data: { sourceType: "engagement", contribution: "supporting", weakSignal: true, hotMaking: true } });
    store.recordEvent({ ...base, requestId: warm.request_id, evaluationId: warm.evaluation_id, leadId: warm.lead_id, idempotencyKey: "warm-run", occurredAt: "2026-01-01T09:00:00.000Z", name: "evaluation.run", data: { outcome: "complete", priorityScore: 70, priorityBand: "Warm" } });
    store.recordEvent({ ...base, requestId: warm.request_id, evaluationId: warm.evaluation_id, leadId: warm.lead_id, evidenceRefs: ["wo-intent"], idempotencyKey: "warm-open", occurredAt: "2026-01-01T09:01:00.000Z", name: "source.contribution", data: { sourceType: "engagement", contribution: "supporting", weakSignal: true, hotMaking: true } });
    assert.equal(store.purgeExpiredEvaluations(admin("tenant-1"), "2026-01-03T00:00:00.000Z"), 1);

    const report = createPilotReport(store.database, "tenant-1", {}, "2026-04-01T00:00:00.000Z");
    assert.equal(report.leads.processed, 2);
    assert.deepEqual(report.weakSignalContribution, { numerator: 1, denominator: 1, rate: 1 });
  } finally {
    store.close();
  }
});
