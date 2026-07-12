import { assertLeadPacket, type Evidence, type LeadPacket, type WritebackOutcomeStatus } from "./contextai.ts";
import type { RuntimeStore } from "./persistence.ts";

export type WritebackFieldType = "string" | "number" | "string[]";

export type WritebackPolicy = Readonly<{
  version: string;
  liveWritesEnabled: boolean;
  maxAgeDays: number;
  allowedSourceTypes: readonly Evidence["source_type"][];
  sourcePrecedence: readonly Evidence["source_type"][];
  blockedFields: readonly string[];
  fields: Readonly<Record<string, Readonly<{
    object: "contact" | "company";
    crmField: string;
    type: WritebackFieldType;
    sideEffects?: boolean;
  }>>>;
}>;

export type WritebackFieldPlan = Readonly<{
  canonicalField: string;
  crmObjectType: "contact" | "company";
  crmObjectId: string;
  crmField: string;
  previousValue?: unknown;
  newValue?: unknown;
  evidence: Evidence;
  outcome: Exclude<WritebackOutcomeStatus, "Data unavailable">;
  reason: string;
}>;

export type WritebackPlan = Readonly<{
  planId: string;
  policyVersion: string;
  packet: LeadPacket;
  policy: WritebackPolicy;
  fields: readonly WritebackFieldPlan[];
}>;

export const hubSpotWritebackPolicy: WritebackPolicy = Object.freeze({
  version: "hubspot-writeback-v0",
  liveWritesEnabled: false,
  maxAgeDays: 90,
  allowedSourceTypes: Object.freeze(["enrichment"] as const),
  sourcePrecedence: Object.freeze(["crm", "enrichment", "public_signal"] as const),
  blockedFields: Object.freeze([
    "lead_status", "lifecycle_stage", "owner", "routing_status", "deal_stage", "forecast_category",
    "opportunity_amount", "disqualification_reason", "external_buying_intent_score",
    "prospect_visible_automation", "sequence_enrollment", "sensitive_personal_data"
  ]),
  fields: Object.freeze({
    employees: Object.freeze({ object: "company", crmField: "numberofemployees", type: "number" }),
    revenue_band: Object.freeze({ object: "company", crmField: "revenue_band", type: "string" }),
    tech_stack: Object.freeze({ object: "company", crmField: "technology_tags", type: "string[]" })
  })
});

const allEvidence = (packet: LeadPacket) => [
  ...packet.crm_context.evidence,
  ...packet.enrichment_fields.evidence,
  ...packet.public_signals.flatMap(({ evidence }) => evidence),
  ...packet.validation_evidence
];

const valuesFrom = (evidence: Evidence) => {
  const values = new Map(Object.entries(evidence.field_values ?? {}));
  if (values.size === 0 && evidence.field_name && evidence.field_value !== undefined) values.set(evidence.field_name, evidence.field_value);
  return values;
};

const validValue = (value: unknown, type: WritebackFieldType) => {
  if (type === "number") return typeof value === "number" && Number.isFinite(value) && value >= 0;
  if (type === "string") return typeof value === "string" && value.trim().length > 0;
  return Array.isArray(value) && value.length > 0 && value.every((item) => typeof item === "string" && item.trim().length > 0);
};

const emptyValue = (value: unknown) => value === "" || (Array.isArray(value) && value.length === 0);
const ageInDays = (packet: LeadPacket, evidence: Evidence) =>
  (Date.parse(packet.evaluation_timestamp) - Date.parse(evidence.source_updated_at ?? "")) / 86_400_000;
const sameValue = (left: unknown, right: unknown) => Array.isArray(left) && Array.isArray(right)
  ? JSON.stringify([...left].sort()) === JSON.stringify([...right].sort())
  : Object.is(left, right);

export const planWriteback = (packet: LeadPacket, policy: WritebackPolicy): WritebackPlan => {
  assertLeadPacket(packet);
  if (!policy.version.trim() || !Number.isSafeInteger(policy.maxAgeDays) || policy.maxAgeDays < 0 || new Set(policy.sourcePrecedence).size !== policy.sourcePrecedence.length) throw new Error("Invalid writeback policy");
  const crmFields = new Set<string>();
  for (const [field, rule] of Object.entries(policy.fields)) {
    if (!field.trim() || !rule.crmField.trim() || crmFields.has(`${rule.object}:${rule.crmField}`)) {
      throw new Error("Invalid writeback policy field mapping");
    }
    crmFields.add(`${rule.object}:${rule.crmField}`);
  }

  const evidence = allEvidence(packet);
  const proposed = new Map<string, Evidence[]>();
  for (const item of evidence.filter(({ source_type }) => policy.allowedSourceTypes.includes(source_type))) {
    for (const field of valuesFrom(item).keys()) proposed.set(field, [...(proposed.get(field) ?? []), item]);
  }

  const fields: WritebackFieldPlan[] = [];
  for (const [canonicalField, candidates] of proposed) {
    const rule = policy.fields[canonicalField];
    const rank = (item: Evidence) => {
      const index = policy.sourcePrecedence.indexOf(item.source_type);
      return index < 0 ? policy.sourcePrecedence.length : index;
    };
    const newestFirst = (left: Evidence, right: Evidence) => Date.parse(right.source_updated_at ?? "") - Date.parse(left.source_updated_at ?? "");
    const candidate = candidates.toSorted((left, right) => rank(left) - rank(right) || newestFirst(left, right))[0]!;
    const newValue = valuesFrom(candidate).get(canonicalField);
    const crmEvidence = evidence.filter((item) => item.source_type === "crm" && valuesFrom(item).has(canonicalField)).toSorted(newestFirst)[0];
    const previousValue = crmEvidence && valuesFrom(crmEvidence).get(canonicalField);
    const base = {
      canonicalField,
      crmObjectType: rule?.object ?? "company" as const,
      crmObjectId: rule?.object === "contact" ? packet.lead_id : packet.account_id ?? "",
      crmField: rule?.crmField ?? canonicalField,
      previousValue,
      newValue,
      evidence: candidate
    };

    if (!rule || rule.sideEffects || policy.blockedFields.includes(canonicalField) || policy.blockedFields.includes(rule.crmField)) fields.push({ ...base, outcome: "Blocked", reason: "Field is not approved by the writeback schema." });
    else if (!base.crmObjectId) fields.push({ ...base, outcome: "Flagged for Review", reason: "The CRM object association is unresolved." });
    else if (emptyValue(newValue)) fields.push({ ...base, outcome: "Skipped", reason: "The proposed value is empty." });
    else if (!validValue(newValue, rule.type)) fields.push({ ...base, outcome: "Blocked", reason: "The proposed value fails the writeback schema." });
    else if (candidate.confidence !== "High" || !candidate.eligible_for_crm_writeback) fields.push({ ...base, outcome: "Flagged for Review", reason: "Evidence does not meet the confidence policy." });
    else if (!Number.isFinite(ageInDays(packet, candidate)) || ageInDays(packet, candidate) < 0 || ageInDays(packet, candidate) > policy.maxAgeDays) fields.push({ ...base, outcome: "Flagged for Review", reason: "Evidence is stale or future-dated." });
    else if (candidates.some((item) => !sameValue(valuesFrom(item).get(canonicalField), newValue)) || (previousValue !== undefined && !sameValue(previousValue, newValue))) fields.push({ ...base, outcome: "Flagged for Review", reason: "A higher-precedence or same-field source conflicts with the proposed value." });
    else if (previousValue !== undefined && sameValue(previousValue, newValue)) fields.push({ ...base, outcome: "Skipped", reason: "CRM already contains the proposed value." });
    else fields.push({ ...base, outcome: "Written", reason: "Field passed schema, source, confidence, freshness, and conflict policy." });
  }

  return Object.freeze({
    planId: `${packet.evaluation_id}:${policy.version}`,
    policyVersion: policy.version,
    packet,
    policy,
    fields: Object.freeze(fields)
  });
};

type Writer = (input: Readonly<{ object: "contact" | "company"; objectId: string; properties: Readonly<Record<string, unknown>> }>) => Promise<void>;

export const executeWriteback = async (
  plan: WritebackPlan,
  options: Readonly<{
    store: RuntimeStore;
    tenantId: string;
    actorType: string;
    mode?: "dry-run" | "live";
    authorizedLiveWrite?: boolean;
    write?: Writer;
  }>
) => {
  const mode = options.mode ?? "dry-run";
  if (mode === "live" && (!plan.policy.liveWritesEnabled || options.authorizedLiveWrite !== true || !options.write)) {
    throw new Error("Live writeback is not explicitly enabled and authorized");
  }

  const results = [];
  for (const field of plan.fields) {
    const auditId = `${mode}:${plan.planId}:${field.crmObjectType}:${field.crmField}`;
    const existing = options.store.getAuditRecord(auditId);
    if (existing) {
      results.push(existing);
      continue;
    }
    const outcome = mode === "dry-run" && field.outcome === "Written" ? "Skipped" : field.outcome;
    const reason = mode === "dry-run" && field.outcome === "Written" ? "Dry run: live CRM writeback is disabled." : field.reason;
    if (outcome === "Written") await options.write!({ object: field.crmObjectType, objectId: field.crmObjectId, properties: { [field.crmField]: field.newValue } });
    options.store.appendAuditRecord({
      auditId, tenantId: options.tenantId, evaluationId: plan.packet.evaluation_id, requestId: plan.packet.request_id,
      crmObjectType: field.crmObjectType, crmObjectId: field.crmObjectId, fieldName: field.crmField,
      previousValue: field.previousValue, newValue: field.newValue, sourceName: field.evidence.source_name,
      sourceRef: field.evidence.source_url ?? field.evidence.source_record_id ?? field.evidence.evidence_id,
      sourceUpdatedAt: field.evidence.source_updated_at ?? field.evidence.retrieved_at,
      confidence: field.evidence.confidence, outcome, reason, scoreVersion: plan.packet.score_version,
      policyVersion: plan.policyVersion, actorType: options.actorType
    });
    results.push(options.store.getAuditRecord(auditId)!);
  }
  return results;
};

export const rollbackWriteback = async (
  auditIds: readonly string[],
  options: Readonly<{ store: RuntimeStore; tenantId: string; actorType: string; authorizedLiveWrite: true; write: Writer }>
) => {
  if (options.authorizedLiveWrite !== true) throw new Error("Rollback is not explicitly authorized");
  const results = [];
  for (const auditId of auditIds) {
    const original = options.store.getAuditRecord(auditId);
    if (!original || original.tenant_id !== options.tenantId || original.outcome !== "Written" || !["contact", "company"].includes(original.crm_object_type)) throw new Error("Only a tenant's Written audit record can be rolled back");
    const rollbackId = `rollback:${auditId}`;
    const existing = options.store.getAuditRecord(rollbackId);
    if (existing) {
      results.push(existing);
      continue;
    }
    await options.write({ object: original.crm_object_type as "contact" | "company", objectId: original.crm_object_id, properties: { [original.field_name]: original.previous_value_json === null ? null : JSON.parse(original.previous_value_json) } });
    options.store.appendAuditRecord({
      auditId: rollbackId, tenantId: original.tenant_id, evaluationId: original.evaluation_id, requestId: original.request_id,
      crmObjectType: original.crm_object_type, crmObjectId: original.crm_object_id, fieldName: original.field_name,
      previousValue: original.new_value_json === null ? undefined : JSON.parse(original.new_value_json),
      newValue: original.previous_value_json === null ? null : JSON.parse(original.previous_value_json),
      sourceName: original.source_name, sourceRef: original.source_ref, sourceUpdatedAt: original.source_updated_at,
      confidence: original.confidence, outcome: "Written", reason: `Rollback of ${auditId}`,
      scoreVersion: original.score_version, policyVersion: original.policy_version, actorType: options.actorType
    });
    options.store.appendRollbackLink(rollbackId, original.tenant_id, original.evaluation_id, auditId, rollbackId);
    results.push(options.store.getAuditRecord(rollbackId)!);
  }
  return results;
};
