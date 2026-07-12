import type { Band, SourceType, WritebackOutcomeStatus } from "./contextai.ts";

export const pilotEventNames = [
  "evaluation.run",
  "score.shown",
  "lead.viewed",
  "action.first_meaningful",
  "recommendation.disposition",
  "source.contribution",
  "writeback.outcome",
  "writeback.edit",
  "writeback.rollback",
  "meeting.attribution",
  "outcome.attribution"
] as const;

export type PilotEventName = typeof pilotEventNames[number];
export type RetentionClass = "pilot_analytics_12_months" | "writeback_audit_24_months";
export type ActorType = "system" | "rep" | "revops_admin" | "integration";
export type ActionType = "call" | "email" | "sequence" | "manual_enrichment" | "nurture" | "disqualify";

type EventData = {
  "evaluation.run": { outcome: "complete" | "partial_failure"; priorityScore: number | null; priorityBand: Band };
  "score.shown": { priorityScore: number | null; priorityBand: Band; surface: "dashboard" | "crm_widget" };
  "lead.viewed": { surface: "dashboard" | "crm_widget" };
  "action.first_meaningful": { actionType: ActionType };
  "recommendation.disposition": { disposition: "accepted" | "ignored" | "overridden"; actionType?: ActionType };
  "source.contribution": { sourceType: SourceType; contribution: "primary" | "supporting"; weakSignal: boolean; hotMaking: boolean };
  "writeback.outcome": { writebackId: string; outcome: WritebackOutcomeStatus; fieldName?: string };
  "writeback.edit": { writebackId: string; fieldName: string };
  "writeback.rollback": { writebackId: string; rollbackId: string; fieldName: string };
  "meeting.attribution": { meetingId: string; attribution: "crm_association" | "rep_reported" };
  "outcome.attribution": { outcomeId: string; outcomeType: "opportunity_created" | "bad_fit" | "disqualified"; attribution: "crm_association" | "rep_reported" };
};

type EventBase = {
  eventId?: string;
  idempotencyKey: string;
  tenantId: string;
  requestId: string;
  evaluationId: string;
  leadId: string;
  accountId: string | null;
  actorType: ActorType;
  actorId: string;
  scoreVersion: string;
  configVersion: string;
  promptVersion?: string;
  evidenceRefs: string[];
  retentionClass: RetentionClass;
  occurredAt: string;
};

export type PilotEvent = {
  [Name in PilotEventName]: EventBase & { name: Name; data: EventData[Name] }
}[PilotEventName];

export type RecordingFailure = Readonly<{ eventName: string; reason: string }>;
export type EventStore = { recordEvent(event: PilotEvent): unknown };

const excludedPiiKeys = new Set([
  "firstname", "lastname", "fullname", "email", "phonenumber", "phone", "postaladdress",
  "streetaddress", "ipaddress", "preciselocation", "notes", "messagebody", "emailbody", "rawpayload"
]);
const email = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i;
const requiredEventData: Record<PilotEventName, readonly string[]> = {
  "evaluation.run": ["outcome", "priorityScore", "priorityBand"],
  "score.shown": ["priorityScore", "priorityBand", "surface"],
  "lead.viewed": ["surface"],
  "action.first_meaningful": ["actionType"],
  "recommendation.disposition": ["disposition"],
  "source.contribution": ["sourceType", "contribution", "weakSignal", "hotMaking"],
  "writeback.outcome": ["writebackId", "outcome"],
  "writeback.edit": ["writebackId", "fieldName"],
  "writeback.rollback": ["writebackId", "rollbackId", "fieldName"],
  "meeting.attribution": ["meetingId", "attribution"],
  "outcome.attribution": ["outcomeId", "outcomeType", "attribution"]
};
const allowedEventData: Partial<Record<PilotEventName, Record<string, readonly unknown[]>>> = {
  "evaluation.run": { outcome: ["complete", "partial_failure"], priorityBand: ["Hot", "Warm", "Cold", "Needs Manual Review"] },
  "score.shown": { priorityBand: ["Hot", "Warm", "Cold", "Needs Manual Review"], surface: ["dashboard", "crm_widget"] },
  "lead.viewed": { surface: ["dashboard", "crm_widget"] },
  "action.first_meaningful": { actionType: ["call", "email", "sequence", "manual_enrichment", "nurture", "disqualify"] },
  "recommendation.disposition": { disposition: ["accepted", "ignored", "overridden"], actionType: ["call", "email", "sequence", "manual_enrichment", "nurture", "disqualify", undefined] },
  "source.contribution": { sourceType: ["crm", "enrichment", "intent", "engagement", "public_signal", "validation"], contribution: ["primary", "supporting"], weakSignal: [true, false], hotMaking: [true, false] },
  "writeback.outcome": { outcome: ["Written", "Skipped", "Flagged for Review", "Blocked", "Data unavailable"] },
  "meeting.attribution": { attribution: ["crm_association", "rep_reported"] },
  "outcome.attribution": { outcomeType: ["opportunity_created", "bad_fit", "disqualified"], attribution: ["crm_association", "rep_reported"] }
};
const nonEmpty = (value: unknown, name: string) => {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} is required`);
};
const isoDate = (value: unknown, name: string) => {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) throw new Error(`${name} must be an ISO date`);
};
const rejectPii = (value: unknown, path = "event") => {
  if (typeof value === "string" && email.test(value)) throw new Error(`${path} contains excluded PII`);
  if (Array.isArray(value)) return value.forEach((item, index) => rejectPii(item, `${path}[${index}]`));
  if (!value || typeof value !== "object") return;
  for (const [key, item] of Object.entries(value)) {
    const normalized = key.toLowerCase().replaceAll(/[_-]/g, "");
    if (excludedPiiKeys.has(normalized)) throw new Error(`${path}.${key} is excluded PII`);
    rejectPii(item, `${path}.${key}`);
  }
};

export function assertPilotEvent(value: unknown): asserts value is PilotEvent {
  if (!value || typeof value !== "object") throw new Error("event must be an object");
  const event = value as Record<string, unknown>;
  if (!pilotEventNames.includes(event.name as PilotEventName)) throw new Error("event name is not supported");
  for (const field of ["idempotencyKey", "tenantId", "requestId", "evaluationId", "leadId", "actorType", "actorId", "scoreVersion", "configVersion", "retentionClass"]) {
    nonEmpty(event[field], field);
  }
  if (event.accountId !== null) nonEmpty(event.accountId, "accountId");
  if (!Array.isArray(event.evidenceRefs) || event.evidenceRefs.some((ref) => typeof ref !== "string" || !ref.trim())) {
    throw new Error("evidenceRefs must contain non-empty identifiers");
  }
  if (!event.data || typeof event.data !== "object") throw new Error("event data is required");
  const data = event.data as Record<string, unknown>;
  for (const field of requiredEventData[event.name as PilotEventName]) {
    if (!Object.hasOwn(data, field)) throw new Error(`${String(event.name)} data.${field} is required`);
    if (field !== "priorityScore" && field !== "weakSignal" && field !== "hotMaking") nonEmpty(data[field], `data.${field}`);
  }
  for (const [field, values] of Object.entries(allowedEventData[event.name as PilotEventName] ?? {})) {
    if (!values.includes(data[field])) throw new Error(`${String(event.name)} data.${field} is not supported`);
  }
  if ((event.name === "evaluation.run" || event.name === "score.shown") && data.priorityScore !== null &&
    (typeof data.priorityScore !== "number" || !Number.isFinite(data.priorityScore) || data.priorityScore < 0 || data.priorityScore > 100)) {
    throw new Error(`${String(event.name)} data.priorityScore must be null or between 0 and 100`);
  }
  isoDate(event.occurredAt, "occurredAt");
  if (!(event.actorType === "system" || event.actorType === "rep" || event.actorType === "revops_admin" || event.actorType === "integration")) {
    throw new Error("actorType is not supported");
  }
  if (!(event.retentionClass === "pilot_analytics_12_months" || event.retentionClass === "writeback_audit_24_months")) {
    throw new Error("retentionClass is not supported");
  }
  if (["score.shown", "recommendation.disposition"].includes(String(event.name))) nonEmpty(event.promptVersion, "promptVersion");
  if (event.name === "source.contribution" && event.evidenceRefs.length === 0) throw new Error("source.contribution requires evidenceRefs");
  const retentionClass = String(event.name).startsWith("writeback.") ? "writeback_audit_24_months" : "pilot_analytics_12_months";
  if (event.retentionClass !== retentionClass) throw new Error(`${String(event.name)} requires ${retentionClass} retention`);
  if (event.eventId !== undefined) nonEmpty(event.eventId, "eventId");
  if (event.promptVersion !== undefined) nonEmpty(event.promptVersion, "promptVersion");
  JSON.stringify(value);
  rejectPii(value);
}

export const createEventRecorder = (
  store: EventStore,
  onFailure: (failure: RecordingFailure) => void = ({ eventName, reason }) => console.error(`Telemetry ${eventName} failed: ${reason}`)
) => function recordEvent(event: PilotEvent): void {
  try {
    store.recordEvent(event);
  } catch (error) {
    const failure = { eventName: event.name, reason: error instanceof Error ? error.message : String(error) };
    try {
      onFailure(failure);
    } catch {
      console.error(`Telemetry ${failure.eventName} failed: ${failure.reason}`);
    }
  }
};

export const coreFields = [
  "company_domain", "company_name", "company_size_band", "industry", "revenue_band", "headquarters_region",
  "linkedin_company_url", "contact_title", "contact_seniority", "contact_department"
] as const;

export const pilotMetricInputs = {
  accepted: { numerator: "distinct evaluations whose first recommendation disposition is accepted", denominator: "distinct evaluations with a recommendation disposition" },
  overridden: { numerator: "distinct evaluations whose first recommendation disposition is overridden", denominator: "distinct evaluations with a recommendation disposition" },
  firstMeaningfulAction: { value: "earliest action.first_meaningful occurredAt after lead.viewed for an evaluation" },
  hotFalsePositive: { numerator: "distinct eligible contacts whose Hot index evaluation has an attributed bad_fit or disqualified outcome", denominator: "distinct eligible contacts with a Hot score.shown for their index evaluation" },
  coreField: { value: "a field listed in coreFields with current source-backed evidence no older than 90 days" },
  badWriteback: { numerator: "distinct Written writeback IDs later rolled back", denominator: "distinct writeback IDs with a writeback.outcome event whose outcome=Written" },
  weakSignalPrimaryDriver: { numerator: "distinct Hot index evaluations with a weak email-open source contribution marked hotMaking", denominator: "distinct Hot index evaluation.run events" }
} as const;
