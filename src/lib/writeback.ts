import { assertLeadPacket, type Evidence, type LeadPacket, type WritebackOutcomeStatus } from "./contextai.ts";
import { defaultScoringConfig, permanentlyBlockedWritebackFields } from "./config.ts";
import type { RuntimeStore } from "./persistence.ts";

export type WritebackFieldType = "string" | "number" | "string[]";
export type PlannedWritebackOutcome = "Eligible" | Exclude<WritebackOutcomeStatus, "Written" | "Data unavailable">;
const permanentlyBlocked = new Set<string>(permanentlyBlockedWritebackFields);

export type WritebackPolicy = Readonly<{
  version: string;
  liveWritesEnabled: boolean;
  maxAgeDays: number;
  minimumConfidence: "High";
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
  outcome: PlannedWritebackOutcome;
  reason: string;
}>;

export type WritebackPlan = Readonly<{
  planId: string;
  policyVersion: string;
  packet: LeadPacket;
  policy: WritebackPolicy;
  outcome: PlannedWritebackOutcome;
  reason: string;
  fields: readonly WritebackFieldPlan[];
}>;

export const hubSpotWritebackPolicy: WritebackPolicy = Object.freeze({
  version: "hubspot-writeback-v0",
  liveWritesEnabled: false,
  maxAgeDays: defaultScoringConfig.freshness.writeback.eligibleThroughDays,
  minimumConfidence: defaultScoringConfig.writeback.minimumConfidence,
  allowedSourceTypes: Object.freeze(["enrichment"] as const),
  sourcePrecedence: Object.freeze([...defaultScoringConfig.sourcePolicy.precedence.firmographic]),
  blockedFields: Object.freeze([...defaultScoringConfig.writeback.blockedFields]),
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

const assertWritebackPolicy = (policy: WritebackPolicy) => {
  if (
    !policy.version.trim() || !Number.isSafeInteger(policy.maxAgeDays) || policy.maxAgeDays < 0 || policy.minimumConfidence !== "High" ||
    policy.allowedSourceTypes.length === 0 || new Set(policy.allowedSourceTypes).size !== policy.allowedSourceTypes.length ||
    new Set(policy.sourcePrecedence).size !== policy.sourcePrecedence.length ||
    policy.allowedSourceTypes.some((source) => !policy.sourcePrecedence.includes(source)) ||
    permanentlyBlockedWritebackFields.some((field) => !policy.blockedFields.includes(field))
  ) throw new Error("Invalid writeback policy");
  const crmFields = new Set<string>();
  for (const [field, rule] of Object.entries(policy.fields)) {
    if (!field.trim() || !rule.crmField.trim() || crmFields.has(`${rule.object}:${rule.crmField}`)) {
      throw new Error("Invalid writeback policy field mapping");
    }
    crmFields.add(`${rule.object}:${rule.crmField}`);
  }
};

export const planWriteback = (packet: LeadPacket, policy: WritebackPolicy): WritebackPlan => {
  assertLeadPacket(packet);
  assertWritebackPolicy(policy);

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
    const freshHighConfidence = (item: Evidence) => item.confidence === policy.minimumConfidence && Number.isFinite(ageInDays(packet, item)) && ageInDays(packet, item) >= 0 && ageInDays(packet, item) <= policy.maxAgeDays;
    const sourceConflict = candidates.some((item) =>
      item !== candidate && item.source_name !== candidate.source_name && rank(item) === rank(candidate) && freshHighConfidence(item) &&
      !sameValue(valuesFrom(item).get(canonicalField), newValue)
    );
    const authoritativeCrmConflict = crmEvidence !== undefined && rank(crmEvidence) <= rank(candidate) && freshHighConfidence(crmEvidence) && !sameValue(previousValue, newValue);
    const base = {
      canonicalField,
      crmObjectType: rule?.object ?? "company" as const,
      crmObjectId: rule?.object === "contact" ? packet.lead_id : packet.account_id ?? "",
      crmField: rule?.crmField ?? canonicalField,
      previousValue,
      newValue,
      evidence: candidate
    };

    if (!rule || rule.sideEffects || permanentlyBlocked.has(canonicalField) || permanentlyBlocked.has(rule.crmField) || policy.blockedFields.includes(canonicalField) || policy.blockedFields.includes(rule.crmField)) fields.push({ ...base, outcome: "Blocked", reason: "Field is not approved by the writeback schema." });
    else if (!base.crmObjectId) fields.push({ ...base, outcome: "Flagged for Review", reason: "The CRM object association is unresolved." });
    else if (emptyValue(newValue)) fields.push({ ...base, outcome: "Skipped", reason: "The proposed value is empty." });
    else if (!validValue(newValue, rule.type)) fields.push({ ...base, outcome: "Blocked", reason: "The proposed value fails the writeback schema." });
    else if (candidate.confidence !== policy.minimumConfidence || !candidate.eligible_for_crm_writeback) fields.push({ ...base, outcome: "Flagged for Review", reason: "Evidence does not meet the confidence policy." });
    else if (!Number.isFinite(ageInDays(packet, candidate)) || ageInDays(packet, candidate) < 0 || ageInDays(packet, candidate) > policy.maxAgeDays) fields.push({ ...base, outcome: "Flagged for Review", reason: "Evidence is stale or future-dated." });
    else if (sourceConflict || authoritativeCrmConflict) fields.push({ ...base, outcome: "Flagged for Review", reason: "A higher-precedence or same-field source conflicts with the proposed value." });
    else if (previousValue !== undefined && sameValue(previousValue, newValue)) fields.push({ ...base, outcome: "Skipped", reason: "CRM already contains the proposed value." });
    else fields.push({ ...base, outcome: "Eligible", reason: "Field passed schema, source, confidence, freshness, and conflict policy." });
  }

  const outcome = fields.some((field) => field.outcome === "Eligible") ? "Eligible"
    : fields.some((field) => field.outcome === "Blocked") ? "Blocked"
    : fields.some((field) => field.outcome === "Flagged for Review") ? "Flagged for Review"
    : "Skipped";
  return Object.freeze({
    planId: `${packet.evaluation_id}:${policy.version}`,
    policyVersion: policy.version,
    packet,
    policy,
    outcome,
    reason: fields.length === 0 ? "No approved evidence fields were proposed." : `Planned ${fields.length} field outcome${fields.length === 1 ? "" : "s"}.`,
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
    actorId: string;
    mode?: "dry-run" | "live";
    authorizedLiveWrite?: boolean;
    write?: Writer;
  }>
) => {
  if (![options.tenantId, options.actorType, options.actorId].every((value) => value.trim())) throw new Error("Tenant and actor identity are required");
  const verifiedPlan = planWriteback(plan.packet, plan.policy);
  const mode = options.mode ?? "dry-run";
  if (mode === "live" && (!verifiedPlan.policy.liveWritesEnabled || options.authorizedLiveWrite !== true || !options.write)) {
    throw new Error("Live writeback is not explicitly enabled and authorized");
  }

  const results = [];
  for (const field of verifiedPlan.fields) {
    const auditId = `${mode}:${verifiedPlan.planId}:${field.crmObjectType}:${field.crmField}`;
    const outcome = field.outcome === "Eligible" ? (mode === "live" ? "Written" : "Skipped") : field.outcome;
    const reason = mode === "dry-run" && field.outcome === "Eligible" ? "Dry run: live CRM writeback is disabled." : field.reason;
    const existing = options.store.getAuditRecord(auditId);
    if (existing) {
      const expectedValue = field.newValue === undefined ? null : JSON.stringify(field.newValue);
      if (existing.tenant_id !== options.tenantId || existing.evaluation_id !== verifiedPlan.packet.evaluation_id || existing.crm_object_type !== field.crmObjectType || existing.crm_object_id !== field.crmObjectId || existing.field_name !== field.crmField || existing.new_value_json !== expectedValue || existing.outcome !== outcome || existing.reason !== reason || existing.policy_version !== verifiedPlan.policyVersion) {
        throw new Error("Writeback idempotency record does not match the verified plan");
      }
      results.push(existing);
      continue;
    }
    if (outcome === "Written") await options.write!({ object: field.crmObjectType, objectId: field.crmObjectId, properties: { [field.crmField]: field.newValue } });
    options.store.appendAuditRecord({
      auditId, tenantId: options.tenantId, evaluationId: verifiedPlan.packet.evaluation_id, requestId: verifiedPlan.packet.request_id,
      crmObjectType: field.crmObjectType, crmObjectId: field.crmObjectId, fieldName: field.crmField,
      previousValue: field.previousValue, newValue: field.newValue, sourceName: field.evidence.source_name,
      sourceRef: field.evidence.source_url ?? field.evidence.source_record_id ?? field.evidence.evidence_id,
      sourceUpdatedAt: field.evidence.source_updated_at ?? field.evidence.retrieved_at,
      confidence: field.evidence.confidence, outcome, reason, scoreVersion: verifiedPlan.packet.score_version,
      policyVersion: verifiedPlan.policyVersion, actorType: options.actorType, actorId: options.actorId
    });
    results.push(options.store.getAuditRecord(auditId)!);
  }
  return results;
};

export const rollbackWriteback = async (
  auditIds: readonly string[],
  options: Readonly<{ store: RuntimeStore; tenantId: string; actorType: string; actorId: string; policy: WritebackPolicy; authorizedLiveWrite: true; write: Writer }>
) => {
  if (![options.tenantId, options.actorType, options.actorId].every((value) => value.trim())) throw new Error("Tenant and actor identity are required");
  assertWritebackPolicy(options.policy);
  if (!options.policy.liveWritesEnabled || options.authorizedLiveWrite !== true) throw new Error("Rollback is not explicitly enabled and authorized");
  const results = [];
  for (const auditId of auditIds) {
    const original = options.store.getAuditRecord(auditId);
    const allowed = Object.values(options.policy.fields).some((field) =>
      field.object === original?.crm_object_type && field.crmField === original.field_name && !field.sideEffects &&
      !permanentlyBlocked.has(field.crmField) && !options.policy.blockedFields.includes(field.crmField)
    );
    if (!original || original.tenant_id !== options.tenantId || original.outcome !== "Written" || original.policy_version !== options.policy.version || !allowed) throw new Error("Only a policy-approved Written audit record can be rolled back");
    const rollbackId = `rollback:${auditId}`;
    const existing = options.store.getAuditRecord(rollbackId);
    if (existing) {
      const expectedValue = original.previous_value_json;
      if (existing.tenant_id !== original.tenant_id || existing.evaluation_id !== original.evaluation_id || existing.crm_object_type !== original.crm_object_type || existing.crm_object_id !== original.crm_object_id || existing.field_name !== original.field_name || existing.new_value_json !== expectedValue || existing.outcome !== "Written" || existing.reason !== `Rollback of ${auditId}` || existing.policy_version !== original.policy_version) {
        throw new Error("Rollback idempotency record does not match the original write");
      }
      if (!options.store.getRollbackLink(rollbackId)) options.store.appendRollbackLink(rollbackId, original.tenant_id, original.evaluation_id, auditId, rollbackId);
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
      scoreVersion: original.score_version, policyVersion: original.policy_version, actorType: options.actorType, actorId: options.actorId
    });
    options.store.appendRollbackLink(rollbackId, original.tenant_id, original.evaluation_id, auditId, rollbackId);
    results.push(options.store.getAuditRecord(rollbackId)!);
  }
  return results;
};

export const rollbackLeadWriteback = (evaluationId: string, options: Parameters<typeof rollbackWriteback>[1]) =>
  rollbackWriteback(options.store.listWrittenAuditRecords(options.tenantId, evaluationId).map(({ audit_id }) => audit_id), options);
