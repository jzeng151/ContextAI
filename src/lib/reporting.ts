import type { DatabaseSync } from "node:sqlite";
import { hasOnlyWeakOpenIntent, type Band, type Evidence, type LeadPacket } from "./contextai.ts";
import { assertPilotEvent, coreFields, type PilotEvent } from "./instrumentation.ts";

export const pilotMetricVersion = "pilot-v1";
const day = 24 * 60 * 60 * 1000;
const bands: Band[] = ["Hot", "Warm", "Cold", "Needs Manual Review"];
const writebackOutcomes = ["Written", "Skipped", "Flagged for Review", "Blocked", "Data unavailable"] as const;

export type PilotReportFilters = Readonly<{
  from?: string;
  to?: string;
  cohort?: "control" | "contextai";
  teamId?: string;
  repId?: string;
  scoreVersion?: string;
  configVersion?: string;
  promptVersion?: string;
  source?: string;
  band?: Band;
}>;

type Evaluation = Readonly<{
  evaluationId: string;
  leadId: string;
  packet: LeadPacket;
  completedAt: string;
  repId: string | null;
  cohort: "control" | "contextai" | null;
  teamId: string | null;
  evaluationKind: "baseline_anchor" | "exposure_index" | "rescore" | null;
}>;

const timestamp = (value: string | undefined, name: string) => {
  if (value === undefined) return undefined;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error(`${name} must be an ISO date`);
  return parsed;
};
const ratio = (numerator: number, denominator: number) => denominator ? numerator / denominator : null;
const median = (values: number[]) => {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
};
const firstBy = <T>(values: T[], key: (value: T) => string) => {
  const result = new Map<string, T>();
  for (const value of values) if (!result.has(key(value))) result.set(key(value), value);
  return result;
};
const eventAt = (event: PilotEvent) => Date.parse(event.occurredAt);
const packetEvidence = (packet: LeadPacket): Evidence[] => [
  ...packet.crm_context.evidence,
  ...packet.enrichment_fields.evidence,
  ...packet.intent_signals.evidence,
  ...packet.engagement_signals.evidence,
  ...packet.public_signals.flatMap(({ evidence }) => evidence),
  ...packet.validation_evidence
];

export function createPilotReport(
  database: DatabaseSync,
  tenantId: string,
  filters: PilotReportFilters = {},
  generatedAt = new Date().toISOString()
) {
  if (!tenantId.trim()) throw new Error("tenantId is required");
  const from = timestamp(filters.from, "from");
  const to = timestamp(filters.to, "to");
  const generated = timestamp(generatedAt, "generatedAt")!;
  if (from !== undefined && to !== undefined && from > to) throw new Error("from must not be after to");
  if (filters.band && !bands.includes(filters.band)) throw new Error("band is not supported");

  const rawEvents = database.prepare(`
    SELECT payload_json FROM events WHERE tenant_id = ? ORDER BY occurred_at, event_id
  `).all(tenantId) as Array<{ payload_json: string }>;
  let invalidEvents = 0;
  const allEvents = rawEvents.flatMap(({ payload_json }) => {
    try {
      const event = JSON.parse(payload_json) as PilotEvent;
      assertPilotEvent(event);
      return [event];
    } catch {
      invalidEvents++;
      return [];
    }
  }).sort((left, right) => eventAt(left) - eventAt(right) || String(left.eventId).localeCompare(String(right.eventId)));
  const allRunByEvaluation = firstBy(allEvents.filter((event): event is Extract<PilotEvent, { name: "evaluation.run" }> => event.name === "evaluation.run"), ({ evaluationId }) => evaluationId);

  const allEvaluations = (database.prepare(`
    SELECT er.evaluation_id, er.lead_id, er.packet_json, er.completed_at,
      pp.rep_id, pp.cohort, pp.team_id, po.evaluation_kind
    FROM evaluation_runs er
    LEFT JOIN pilot_evaluation_owners po
      ON po.tenant_id = er.tenant_id AND po.evaluation_id = er.evaluation_id
    LEFT JOIN pilot_participants pp
      ON pp.tenant_id = po.tenant_id AND pp.rep_id = po.rep_id
      AND julianday(er.completed_at) >= julianday(pp.active_from)
      AND (pp.active_to IS NULL OR julianday(er.completed_at) <= julianday(pp.active_to))
    WHERE er.tenant_id = ? AND er.purged_at IS NULL
    ORDER BY er.completed_at, er.evaluation_id
  `).all(tenantId) as Array<Record<string, string | null>>).map((row): Evaluation => ({
    evaluationId: row.evaluation_id!,
    leadId: row.lead_id!,
    packet: JSON.parse(row.packet_json!) as LeadPacket,
    completedAt: row.completed_at!,
    repId: row.rep_id,
    cohort: row.cohort as Evaluation["cohort"],
    teamId: row.team_id,
    evaluationKind: row.evaluation_kind as Evaluation["evaluationKind"]
  })).sort((left, right) => Date.parse(left.completedAt) - Date.parse(right.completedAt) || left.evaluationId.localeCompare(right.evaluationId));
  const inWindow = (evaluation: Evaluation) => {
    const at = Date.parse(evaluation.completedAt);
    return (from === undefined || at >= from) && (to === undefined || at <= to);
  };
  const anchors = allEvaluations.filter((evaluation) => inWindow(evaluation) && evaluation.evaluationKind !== "rescore");
  const allIndexes = new Map([
    ...firstBy(anchors.filter(({ evaluationKind }) => evaluationKind === "baseline_anchor"), ({ leadId }) => leadId),
    ...firstBy(anchors.filter(({ evaluationKind }) => evaluationKind !== "baseline_anchor"), ({ leadId }) => leadId)
  ]);
  const windowEvaluations = allEvaluations.filter(inWindow);
  const matchesSegments = (evaluation: Evaluation) =>
      (!filters.cohort || evaluation.cohort === filters.cohort) &&
      (!filters.teamId || evaluation.teamId === filters.teamId) &&
      (!filters.repId || evaluation.repId === filters.repId) &&
      (!filters.scoreVersion || evaluation.packet.score_version === filters.scoreVersion) &&
      (!filters.source || evaluation.packet.crm_context.source === filters.source) &&
      (!filters.configVersion || allRunByEvaluation.get(evaluation.evaluationId)?.configVersion === filters.configVersion);
  const candidateEvaluations = windowEvaluations.filter(matchesSegments);
  const evaluations = candidateEvaluations.filter((evaluation) => !filters.band || evaluation.packet.priority_band === filters.band);

  const evaluationIds = new Set(evaluations.map(({ evaluationId }) => evaluationId));
  const events = allEvents.filter((event) => evaluationIds.has(event.evaluationId) &&
    (!filters.configVersion || event.configVersion === filters.configVersion));
  const byEvaluation = new Map(evaluations.map((evaluation) => [evaluation.evaluationId, evaluation]));
  const indexEvaluations = new Map([...allIndexes].filter(([, evaluation]) => matchesSegments(evaluation) && (!filters.band || evaluation.packet.priority_band === filters.band)));
  const indexEvaluationIds = new Set([...indexEvaluations.values()].map(({ evaluationId }) => evaluationId));
  const eventRuns = events.filter((event): event is Extract<PilotEvent, { name: "evaluation.run" }> => event.name === "evaluation.run");
  const runByEvaluation = firstBy(eventRuns, ({ evaluationId }) => evaluationId);
  const indexRuns = new Map([...indexEvaluations].flatMap(([leadId, { evaluationId }]) => {
    const run = runByEvaluation.get(evaluationId);
    return run ? [[leadId, run] as const] : [];
  }));
  const leadsByBand = Object.fromEntries(bands.map((band) => [band, [...indexRuns.values()].filter(({ data }) => data.priorityBand === band).length]));

  const controlRecommendationExposure = new Set(events.filter((event) => ["score.shown", "recommendation.disposition"].includes(event.name) && byEvaluation.get(event.evaluationId)?.cohort === "control").map(({ evaluationId }) => evaluationId));
  const controlWritebackExposure = new Set(events.filter((event) => event.name.startsWith("writeback.") && byEvaluation.get(event.evaluationId)?.cohort === "control").map(({ evaluationId }) => evaluationId));
  const recommendationEvents = events.filter((event) => byEvaluation.get(event.evaluationId)?.cohort === "contextai");
  const shown = firstBy(recommendationEvents.filter((event): event is Extract<PilotEvent, { name: "score.shown" }> => event.name === "score.shown" && (!filters.promptVersion || event.promptVersion === filters.promptVersion)), ({ evaluationId }) => evaluationId);
  const allDispositionEvents = recommendationEvents.filter((event): event is Extract<PilotEvent, { name: "recommendation.disposition" }> => event.name === "recommendation.disposition" && (!filters.promptVersion || event.promptVersion === filters.promptVersion));
  const dispositionEvents = allDispositionEvents.filter((event) => {
    const score = shown.get(event.evaluationId);
    return score && eventAt(event) >= eventAt(score) && eventAt(event) - eventAt(score) <= day;
  });
  const dispositions = firstBy(dispositionEvents, ({ evaluationId }) => evaluationId);
  const accepted = [...dispositions.values()].filter(({ data }) => data.disposition === "accepted").length;
  const overridden = [...dispositions.values()].filter(({ data }) => data.disposition === "overridden").length;

  const views = firstBy(events.filter((event): event is Extract<PilotEvent, { name: "lead.viewed" }> => event.name === "lead.viewed" && indexEvaluationIds.has(event.evaluationId)), ({ evaluationId }) => evaluationId);
  const actions = events.filter((event): event is Extract<PilotEvent, { name: "action.first_meaningful" }> => event.name === "action.first_meaningful");
  const researchMinutes: number[] = [];
  let lateActions = 0;
  for (const [evaluationId, view] of views) {
    const action = actions.find((candidate) => candidate.evaluationId === evaluationId && eventAt(candidate) >= eventAt(view));
    if (!action) continue;
    const elapsed = eventAt(action) - eventAt(view);
    if (elapsed <= day) researchMinutes.push(elapsed / 60_000);
    else lateActions++;
  }

  const allMeetingEvents = events.filter((event): event is Extract<PilotEvent, { name: "meeting.attribution" }> => event.name === "meeting.attribution");
  const meetingEvents = allMeetingEvents.filter((event) => {
    const run = runByEvaluation.get(event.evaluationId);
    return indexEvaluationIds.has(event.evaluationId) && run && eventAt(event) >= eventAt(run) && eventAt(event) - eventAt(run) <= 60 * day;
  });
  const meetings = new Map<string, typeof meetingEvents[number]>();
  const meetingsByEvaluation = new Map<string, typeof meetingEvents[number]>();
  for (const event of meetingEvents) {
    const existing = meetings.get(event.data.meetingId);
    if (!existing || event.data.attribution === "crm_association") meetings.set(event.data.meetingId, event);
    const evaluationKey = `${event.evaluationId}\0${event.data.meetingId}`;
    const evaluationMeeting = meetingsByEvaluation.get(evaluationKey);
    if (!evaluationMeeting || event.data.attribution === "crm_association") meetingsByEvaluation.set(evaluationKey, event);
  }
  const participants = (database.prepare(`
    SELECT rep_id, cohort, team_id, active_from, active_to FROM pilot_participants WHERE tenant_id = ?
  `).all(tenantId) as Array<Record<string, string | null>>).filter((participant) =>
    (!filters.cohort || participant.cohort === filters.cohort) &&
    (!filters.teamId || participant.team_id === filters.teamId) &&
    (!filters.repId || participant.rep_id === filters.repId) &&
    Date.parse(participant.active_from!) <= (to ?? generated) &&
    (from === undefined || participant.active_to === null || Date.parse(participant.active_to) >= from)
  );
  const enrolledReps = new Set(participants.map(({ rep_id }) => rep_id!));
  const activeRepWeeks = participants.reduce((total, participant) => {
    const start = Math.max(Date.parse(participant.active_from!), from ?? Date.parse(participant.active_from!));
    const end = Math.min(participant.active_to === null ? (to ?? generated) : Date.parse(participant.active_to), to ?? generated);
    return total + Math.max(0, end - start) / (7 * day);
  }, 0);
  const meetingsByRep: Record<string, number> = Object.fromEntries([...enrolledReps].map((repId) => [repId, 0]));
  let meetingsMissingOwner = 0;
  let attributedMeetings = 0;
  for (const event of meetings.values()) {
    const repId = byEvaluation.get(event.evaluationId)?.repId;
    if (repId) {
      meetingsByRep[repId] = (meetingsByRep[repId] ?? 0) + 1;
      attributedMeetings++;
    }
    else meetingsMissingOwner++;
  }
  const matured = [...indexEvaluations.values()].filter(({ evaluationId }) => {
    const run = runByEvaluation.get(evaluationId);
    return run && generated - eventAt(run) >= 60 * day;
  });
  const conversions = Object.fromEntries((["Hot", "Warm"] as const).map((band) => {
    const denominator = matured.filter(({ evaluationId, cohort }) => (cohort === "contextai" ? shown.get(evaluationId) : cohort === "control" ? runByEvaluation.get(evaluationId) : undefined)?.data.priorityBand === band);
    const numerator = denominator.filter(({ evaluationId }) => [...meetingsByEvaluation.values()].some((meeting) => meeting.evaluationId === evaluationId));
    return [band, { numerator: numerator.length, denominator: denominator.length, rate: ratio(numerator.length, denominator.length) }];
  }));

  const outcomeEvents = events.filter((event): event is Extract<PilotEvent, { name: "outcome.attribution" }> => {
    if (event.name !== "outcome.attribution") return false;
    const run = runByEvaluation.get(event.evaluationId);
    return indexEvaluationIds.has(event.evaluationId) && run !== undefined && eventAt(event) >= eventAt(run) && eventAt(event) - eventAt(run) <= 60 * day;
  });
  const outcomes = new Map<string, typeof outcomeEvents[number]>();
  for (const event of outcomeEvents) {
    const existing = outcomes.get(event.data.outcomeId);
    if (!existing || (existing.data.attribution === "rep_reported" && event.data.attribution === "crm_association")) outcomes.set(event.data.outcomeId, event);
  }
  const firstOutcomes = firstBy([...outcomes.values()].sort((left, right) => eventAt(left) - eventAt(right)), ({ evaluationId }) => evaluationId);
  const maturedHot = matured.filter(({ evaluationId }) => shown.get(evaluationId)?.data.priorityBand === "Hot");
  const falsePositiveLeads = new Set(maturedHot.filter(({ evaluationId }) => ["bad_fit", "disqualified"].includes(firstOutcomes.get(evaluationId)?.data.outcomeType ?? "")).map(({ leadId }) => leadId));
  const hotLeads = new Set(maturedHot.map(({ leadId }) => leadId));

  const treatmentWritebackEvents = events.filter((event) => byEvaluation.get(event.evaluationId)?.cohort === "contextai");
  const writeEvents = treatmentWritebackEvents.filter((event): event is Extract<PilotEvent, { name: "writeback.outcome" }> => event.name === "writeback.outcome");
  const written = firstBy(writeEvents.filter(({ data }) => data.outcome === "Written"), ({ data }) => data.writebackId);
  const pendingWrites = [...written.values()].filter((event) => generated - eventAt(event) < 30 * day);
  const maturedWritten = firstBy([...written.values()].filter((event) => generated - eventAt(event) >= 30 * day), ({ data }) => data.writebackId);
  const writtenIds = new Set(maturedWritten.keys());
  const rollbackIds = new Set(treatmentWritebackEvents.filter((event): event is Extract<PilotEvent, { name: "writeback.rollback" }> => {
    if (event.name !== "writeback.rollback") return false;
    const write = maturedWritten.get(event.data.writebackId);
    return write !== undefined && eventAt(event) >= eventAt(write) && eventAt(event) - eventAt(write) <= 30 * day;
  }).map(({ data }) => data.writebackId));
  const writebacksByOutcome = Object.fromEntries(writebackOutcomes.map((outcome) => [outcome, new Set(writeEvents.filter(({ data }) => data.outcome === outcome).map(({ data }) => data.writebackId)).size]));
  const writebacksByField: Record<string, Record<string, number>> = {};
  const fieldWritebacks = firstBy(writeEvents.filter(({ data }) => data.fieldName), ({ data }) => `${data.writebackId}\0${data.fieldName}\0${data.outcome}`);
  for (const { data } of fieldWritebacks.values()) {
    if (!data.fieldName) continue;
    const field = writebacksByField[data.fieldName] ??= {};
    field[data.outcome] = (field[data.outcome] ?? 0) + 1;
  }

  const driverTotals: Record<string, number> = {};
  const missingFields: Record<string, number> = {};
  const staleFields: Record<string, number> = {};
  const coreFieldCoverage = Object.fromEntries(coreFields.map((field) => [field, 0])) as Record<typeof coreFields[number], number>;
  let completeRecords = 0;
  for (const { packet } of indexEvaluations.values()) {
    for (const [driver, points] of Object.entries(packet.score_breakdown)) driverTotals[driver] = (driverTotals[driver] ?? 0) + points;
    for (const field of packet.missing_fields) missingFields[field] = (missingFields[field] ?? 0) + 1;
    for (const field of packet.stale_fields) staleFields[field] = (staleFields[field] ?? 0) + 1;
    const current = new Set<string>();
    for (const evidence of packetEvidence(packet)) {
      const sourceAt = evidence.source_updated_at ?? evidence.source_published_at;
      if (!sourceAt || Date.parse(packet.evaluation_timestamp) - Date.parse(sourceAt) > 90 * day) continue;
      if (evidence.field_name) current.add(evidence.field_name);
      for (const field of Object.keys(evidence.field_values ?? {})) current.add(field);
    }
    if (current.has("employees") || current.has("numberofemployees")) current.add("company_size_band");
    for (const field of coreFields) if (current.has(field)) coreFieldCoverage[field]++;
    if (coreFields.every((field) => current.has(field))) completeRecords++;
  }

  const weakHotEvaluations = new Set(events.filter((event): event is Extract<PilotEvent, { name: "source.contribution" }> => {
    if (event.name !== "source.contribution" || !indexEvaluationIds.has(event.evaluationId) || !event.data.weakSignal || !event.data.hotMaking || event.data.sourceType !== "engagement") return false;
    const packet = byEvaluation.get(event.evaluationId)?.packet;
    return packet !== undefined && hasOnlyWeakOpenIntent(packet) && event.evidenceRefs.some((ref) => {
      const evidence = packetEvidence(packet).find(({ evidence_id }) => evidence_id === ref);
      const fields = evidence?.field_values;
      return evidence?.source_type === "engagement" && Number(fields?.opens ?? 0) > 0 &&
        Number(fields?.clicks ?? 0) === 0 && Number(fields?.replies ?? 0) === 0 &&
        !fields?.demo_request && !fields?.pricing_page_visit;
    });
  }).map(({ evaluationId }) => evaluationId));
  const hotRuns = new Set([...indexEvaluations.values()].filter(({ evaluationId }) => runByEvaluation.get(evaluationId)?.data.priorityBand === "Hot").map(({ evaluationId }) => evaluationId));
  const missingEvaluationRuns = indexEvaluations.size - indexRuns.size;
  const missingOwnerSnapshots = evaluations.filter(({ repId }) => repId === null).length;
  const caveats = [
    ...(missingEvaluationRuns ? [`${missingEvaluationRuns} evaluation(s) lack evaluation.run telemetry; missing data is excluded, not counted as zero.`] : []),
    ...(missingOwnerSnapshots ? [`${missingOwnerSnapshots} evaluation(s) lack a frozen owner snapshot; rep and cohort metrics are incomplete.`] : []),
    ...(meetingsMissingOwner ? [`${meetingsMissingOwner} meeting(s) lack a frozen owner snapshot.`] : []),
    ...(controlRecommendationExposure.size ? [`${controlRecommendationExposure.size} control evaluation(s) emitted recommendation exposure; cohort leakage requires review.`] : []),
    ...(controlWritebackExposure.size ? [`${controlWritebackExposure.size} control evaluation(s) emitted writeback activity; cohort leakage requires review.`] : []),
    ...(lateActions ? [`${lateActions} first action(s) occurred outside the approved 24-hour research window.`] : []),
    ...(invalidEvents ? [`${invalidEvents} invalid stored event(s) were excluded.`] : []),
    ...(pendingWrites.length ? [`${pendingWrites.length} written writeback(s) lack a complete 30-day rollback window and were excluded.`] : []),
    ...(!evaluations.length ? ["No evaluations match this tenant and filter window; metrics are unavailable, not zero."] : []),
    ...(matured.length < indexEvaluations.size ? ["Outcome metrics exclude index evaluations without a complete 60-day maturation window."] : [])
  ];

  return {
    metadata: { metricVersion: pilotMetricVersion, tenantId, filters, window: { from: filters.from ?? null, to: filters.to ?? null }, generatedAt, caveats },
    leads: { processed: indexRuns.size, byBand: leadsByBand },
    recommendations: {
      accepted: { numerator: accepted, denominator: dispositions.size, rate: ratio(accepted, dispositions.size) },
      overridden: { numerator: overridden, denominator: dispositions.size, rate: ratio(overridden, dispositions.size) },
      coverage: { numerator: dispositions.size, denominator: shown.size, rate: ratio(dispositions.size, shown.size) }
    },
    researchTime: { observed: researchMinutes.length, eligibleViews: views.size, censored: views.size - researchMinutes.length, coverage: ratio(researchMinutes.length, views.size), medianMinutes: median(researchMinutes) },
    meetings: { total: attributedMeetings, enrolledReps: enrolledReps.size, activeRepWeeks, perRep: ratio(attributedMeetings, enrolledReps.size), perActiveRepWeek: ratio(attributedMeetings, activeRepWeeks), byRep: meetingsByRep },
    conversion: conversions,
    hotFalsePositives: { numerator: falsePositiveLeads.size, denominator: hotLeads.size, rate: ratio(falsePositiveLeads.size, hotLeads.size), missingOutcomes: maturedHot.filter(({ evaluationId }) => !firstOutcomes.has(evaluationId)).length },
    crmCompleteness: { numerator: completeRecords, denominator: indexEvaluations.size, rate: ratio(completeRecords, indexEvaluations.size), fieldCoverage: coreFieldCoverage },
    writebacks: { rolledBack: rollbackIds.size, written: writtenIds.size, rate: ratio(rollbackIds.size, writtenIds.size), byOutcome: writebacksByOutcome, byField: writebacksByField },
    topScoreDrivers: Object.entries(driverTotals).sort((left, right) => right[1] - left[1]).map(([driver, points]) => ({ driver, points })),
    missingFields,
    freshness: { staleFields },
    weakSignalContribution: { numerator: weakHotEvaluations.size, denominator: hotRuns.size, rate: ratio(weakHotEvaluations.size, hotRuns.size) },
    dataQuality: {
      status: !evaluations.length ? "no_data" : caveats.length ? "incomplete" : "complete",
      storedEvaluations: evaluations.length,
      missingEvaluationRuns,
      missingOwnerSnapshots,
      duplicateDispositionEvents: allDispositionEvents.length - dispositions.size,
      duplicateMeetingEvents: meetingEvents.length - meetings.size,
      controlRecommendationExposure: controlRecommendationExposure.size,
      controlWritebackExposure: controlWritebackExposure.size,
      lateActions,
      invalidEvents,
      caveats
    }
  } as const;
}

const csvCell = (value: unknown) => `"${String(value ?? "").replaceAll('"', '""')}"`;

export function exportPilotReport(report: ReturnType<typeof createPilotReport>) {
  const rows: unknown[][] = [["metric_version", "tenant_id", "cohort", "team_id", "rep_id", "score_version", "config_version", "prompt_version", "source", "band", "window_from", "window_to", "generated_at", "metric", "numerator", "denominator", "value", "caveats"]];
  const filters = report.metadata.filters;
  const metadata = (promptScoped: boolean) => [report.metadata.metricVersion, report.metadata.tenantId, filters.cohort ?? "all", filters.teamId ?? "all", filters.repId ?? "all", filters.scoreVersion ?? "all", filters.configVersion ?? "all", promptScoped ? filters.promptVersion ?? "all" : "all", filters.source ?? "all", filters.band ?? "all", report.metadata.window.from ?? "", report.metadata.window.to ?? "", report.metadata.generatedAt];
  const caveats = report.metadata.caveats.join(" ");
  const add = (metric: string, numerator: number | null, denominator: number | null, value: number | null, promptScoped = false) => rows.push([...metadata(promptScoped), metric, numerator, denominator, value, caveats]);
  add("leads_processed", report.leads.processed, report.leads.processed, report.leads.processed);
  add("recommendation_acceptance", report.recommendations.accepted.numerator, report.recommendations.accepted.denominator, report.recommendations.accepted.rate, true);
  add("recommendation_override", report.recommendations.overridden.numerator, report.recommendations.overridden.denominator, report.recommendations.overridden.rate, true);
  add("research_time_median_minutes", report.researchTime.observed, report.researchTime.eligibleViews, report.researchTime.medianMinutes);
  add("meetings_per_rep", report.meetings.total, report.meetings.enrolledReps, report.meetings.perRep);
  add("meetings_per_active_rep_week", report.meetings.total, report.meetings.activeRepWeeks, report.meetings.perActiveRepWeek);
  add("hot_conversion", report.conversion.Hot.numerator, report.conversion.Hot.denominator, report.conversion.Hot.rate, true);
  add("warm_conversion", report.conversion.Warm.numerator, report.conversion.Warm.denominator, report.conversion.Warm.rate, true);
  add("hot_false_positive", report.hotFalsePositives.numerator, report.hotFalsePositives.denominator, report.hotFalsePositives.rate, true);
  add("crm_completeness", report.crmCompleteness.numerator, report.crmCompleteness.denominator, report.crmCompleteness.rate);
  add("writeback_rollback", report.writebacks.rolledBack, report.writebacks.written, report.writebacks.rate);
  for (const [outcome, count] of Object.entries(report.writebacks.byOutcome)) add(`writeback_outcome:${outcome}`, count, report.leads.processed, count);
  add("weak_signal_contribution", report.weakSignalContribution.numerator, report.weakSignalContribution.denominator, report.weakSignalContribution.rate);
  for (const [band, count] of Object.entries(report.leads.byBand)) add(`leads_band:${band}`, count, report.leads.processed, ratio(count, report.leads.processed));
  for (const [repId, count] of Object.entries(report.meetings.byRep)) add(`meetings_rep:${repId}`, count, 1, count);
  for (const { driver, points } of report.topScoreDrivers) add(`score_driver:${driver}`, points, report.crmCompleteness.denominator, points);
  for (const [field, count] of Object.entries(report.missingFields)) add(`missing_field:${field}`, count, report.crmCompleteness.denominator, ratio(count, report.crmCompleteness.denominator));
  for (const [field, count] of Object.entries(report.freshness.staleFields)) add(`stale_field:${field}`, count, report.crmCompleteness.denominator, ratio(count, report.crmCompleteness.denominator));
  return rows.map((row) => row.map(csvCell).join(",")).join("\n") + "\n";
}

export function reportFiltersFrom(search: URLSearchParams): PilotReportFilters {
  const value = (name: string) => search.get(name) || undefined;
  const cohort = value("cohort");
  const band = value("band");
  if (cohort && cohort !== "control" && cohort !== "contextai") throw new Error("cohort is not supported");
  if (band && !bands.includes(band as Band)) throw new Error("band is not supported");
  return {
    from: value("from"), to: value("to"), cohort: cohort as PilotReportFilters["cohort"],
    teamId: value("teamId"), repId: value("repId"), scoreVersion: value("scoreVersion"),
    configVersion: value("configVersion"), promptVersion: value("promptVersion"), source: value("source"), band: band as Band | undefined
  };
}
