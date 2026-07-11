import type { Band, ManualReviewReason, ScoreBreakdown, SourceType } from "./contextai.ts";

const scoreCategories = ["icp_fit", "high_intent_actions", "engagement_quality", "public_timing_signals", "crm_process_context", "data_confidence"] as const;
const numericBands = ["Cold", "Warm", "Hot"] as const;
const sourceTypes: SourceType[] = ["crm", "enrichment", "intent", "engagement", "public_signal", "validation"];
const sourceFamilies = ["workflow", "association", "duplicate", "firmographic", "contact", "intent", "engagement", "publicSignal"] as const;
const configSections = ["categoryWeights", "bandThresholds", "confidenceRules", "manualReview", "freshness", "sourcePolicy", "weakSignals", "writeback"] as const;
const manualReviewTriggers: ManualReviewReason[] = [
  "missing_required_data",
  "uncertain_identity",
  "duplicate_risk",
  "ambiguous_account",
  "invalid_source_result",
  "source_conflict",
  "unsafe_workflow_state",
  "scoring_unavailable"
];

export const canonicalWritebackFields = Object.freeze({
  contact: Object.freeze(["contact_title", "contact_seniority", "contact_department", "last_enrichment_verified_at", "enrichment_source_name"]),
  company: Object.freeze(["company_domain", "company_name", "company_size_band", "industry", "revenue_band", "headquarters_region", "linkedin_company_url", "technology_tags", "hiring_signal", "funding_signal", "last_enrichment_verified_at", "enrichment_source_name"])
} as const);

export const permanentlyBlockedWritebackFields = Object.freeze([
  "lead_status",
  "lifecycle_stage",
  "owner",
  "routing_status",
  "deal_stage",
  "forecast_category",
  "opportunity_amount",
  "disqualification_reason",
  "external_buying_intent_score",
  "prospect_visible_automation",
  "sequence_enrollment",
  "sensitive_personal_data"
] as const);

export type NumericBand = Exclude<Band, "Needs Manual Review">;
export type SourceFamily = typeof sourceFamilies[number];
export type ConfigSection = typeof configSections[number];
export type WritebackObject = keyof typeof canonicalWritebackFields;
export type CanonicalWritebackField = typeof canonicalWritebackFields[WritebackObject][number];
// A category's weight is also its maximum point contribution (cap).
export type ScoreCategoryWeightsAndCaps = Readonly<ScoreBreakdown>;

export type ScoringConfig = Readonly<{
  categoryWeights: ScoreCategoryWeightsAndCaps;
  bandThresholds: Readonly<Record<NumericBand, number>>;
  confidenceRules: Readonly<{
    high: Readonly<{ requiredDataPresent: true; keySourcesFresh: true; materialConflictsAllowed: false }>;
    medium: Readonly<{ requiredDataPresent: true; optionalDataMayBeMissing: true; maxNonKeyStaleSources: 1; limitedSignalsAllowed: true; materialConflictsAllowed: false }>;
    low: Readonly<{ fallbackWhenHigherRulesFail: true }>;
  }>;
  manualReview: Readonly<{
    priorityBand: "Needs Manual Review";
    priorityScore: null;
    confidence: "Low";
    precedesNumericBands: true;
    triggers: readonly ManualReviewReason[];
  }>;
  freshness: Readonly<{
    intent: Readonly<{ freshThroughDays: number }>;
    engagement: Readonly<{ freshThroughDays: number }>;
    publicSignal: Readonly<{ freshThroughDays: number }>;
    firmographic: Readonly<{ freshThroughDays: number; staleAfterDays: number }>;
    contact: Readonly<{ freshThroughDays: number; manualReviewAfterDays: number }>;
    writeback: Readonly<{ eligibleThroughDays: number }>;
  }>;
  sourcePolicy: Readonly<{
    approvedSourceTypes: readonly SourceType[];
    precedence: Readonly<Record<SourceFamily, readonly SourceType[]>>;
  }>;
  weakSignals: Readonly<{
    emailOpens: Readonly<{ sourceType: "engagement"; countsAsBuyingIntent: false; canProduceHotAlone: false }>;
  }>;
  writeback: Readonly<{
    minimumConfidence: "High";
    approvedSourceTypes: readonly SourceType[];
    allowlist: Readonly<Record<WritebackObject, readonly CanonicalWritebackField[]>>;
    blockedFields: readonly string[];
  }>;
}>;

export type ConfigVersionStatus = "draft" | "active" | "inactive";
export type ScoringConfigVersion = Readonly<{
  id: string;
  author: string;
  createdAt: string;
  status: ConfigVersionStatus;
  changeSummary: string;
  adminNotes: string;
  config: ScoringConfig;
}>;

export type ScoringRunContext = Readonly<{
  score_version: string;
  config: ScoringConfig;
}>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const sameKeys = (value: Record<string, unknown>, keys: readonly string[]) =>
  Object.keys(value).length === keys.length && Object.keys(value).every((key) => keys.includes(key));
function fail(message: string): never {
  throw new Error(`Invalid scoring configuration: ${message}`);
}
const deepFreeze = <T>(value: T): T => {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
};
const immutable = <T>(value: T): T => deepFreeze(structuredClone(value));
const finiteRange = (value: unknown, minimum: number, maximum: number) =>
  typeof value === "number" && Number.isFinite(value) && value >= minimum && value <= maximum;
const days = (value: unknown) => Number.isSafeInteger(value) && (value as number) >= 0;
const uniqueStrings = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string" && item.trim().length > 0) && new Set(value).size === value.length;
const exactStringSet = (value: unknown, required: readonly string[]) =>
  uniqueStrings(value) && value.length === required.length && required.every((item) => value.includes(item));

export function assertScoringConfig(value: unknown): asserts value is ScoringConfig {
  if (!isRecord(value) || !sameKeys(value, configSections)) fail("unexpected top-level fields");

  if (!isRecord(value.categoryWeights) || !sameKeys(value.categoryWeights, scoreCategories)) fail("category weights must use the six score categories");
  const categoryWeights = value.categoryWeights;
  const weights = scoreCategories.map((category) => categoryWeights[category]);
  if (weights.some((weight) => !finiteRange(weight, 0, 100))) fail("category weights must be finite values from 0 to 100");
  if (Math.abs(weights.reduce<number>((total, weight) => total + Number(weight), 0) - 100) > Number.EPSILON * 100) fail("category weights must total 100");

  if (!isRecord(value.bandThresholds) || !sameKeys(value.bandThresholds, numericBands)) fail("numeric bands must be Cold, Warm, and Hot");
  const bandThresholds = value.bandThresholds;
  const thresholds = numericBands.map((band) => bandThresholds[band]);
  if (thresholds.some((threshold) => !finiteRange(threshold, 0, 100)) || thresholds[0] !== 0 || !(Number(thresholds[0]) < Number(thresholds[1]) && Number(thresholds[1]) < Number(thresholds[2]))) {
    fail("band thresholds must cover 0 through 100 in Cold, Warm, Hot order");
  }

  if (!isRecord(value.confidenceRules) || !sameKeys(value.confidenceRules, ["high", "medium", "low"])) fail("confidence rules are incomplete");
  const { high, medium, low } = value.confidenceRules;
  if (!isRecord(high) || !sameKeys(high, ["requiredDataPresent", "keySourcesFresh", "materialConflictsAllowed"]) || high.requiredDataPresent !== true || high.keySourcesFresh !== true || high.materialConflictsAllowed !== false ||
    !isRecord(medium) || !sameKeys(medium, ["requiredDataPresent", "optionalDataMayBeMissing", "maxNonKeyStaleSources", "limitedSignalsAllowed", "materialConflictsAllowed"]) || medium.requiredDataPresent !== true || medium.optionalDataMayBeMissing !== true || medium.maxNonKeyStaleSources !== 1 || medium.limitedSignalsAllowed !== true || medium.materialConflictsAllowed !== false ||
    !isRecord(low) || !sameKeys(low, ["fallbackWhenHigherRulesFail"]) || low.fallbackWhenHigherRulesFail !== true) fail("confidence safety rules cannot be weakened");

  if (!isRecord(value.manualReview) || !sameKeys(value.manualReview, ["priorityBand", "priorityScore", "confidence", "precedesNumericBands", "triggers"]) ||
    value.manualReview.priorityBand !== "Needs Manual Review" || value.manualReview.priorityScore !== null || value.manualReview.confidence !== "Low" || value.manualReview.precedesNumericBands !== true || !exactStringSet(value.manualReview.triggers, manualReviewTriggers)) {
    fail("manual review must be a Low-confidence, nonnumeric override with every locked trigger");
  }

  if (!isRecord(value.freshness) || !sameKeys(value.freshness, ["intent", "engagement", "publicSignal", "firmographic", "contact", "writeback"])) fail("freshness rules are incomplete");
  const freshness = value.freshness;
  if (!isRecord(freshness.intent) || !sameKeys(freshness.intent, ["freshThroughDays"]) || !days(freshness.intent.freshThroughDays) ||
    !isRecord(freshness.engagement) || !sameKeys(freshness.engagement, ["freshThroughDays"]) || !days(freshness.engagement.freshThroughDays) ||
    !isRecord(freshness.publicSignal) || !sameKeys(freshness.publicSignal, ["freshThroughDays"]) || !days(freshness.publicSignal.freshThroughDays) ||
    !isRecord(freshness.firmographic) || !sameKeys(freshness.firmographic, ["freshThroughDays", "staleAfterDays"]) || !days(freshness.firmographic.freshThroughDays) || !days(freshness.firmographic.staleAfterDays) || Number(freshness.firmographic.freshThroughDays) >= Number(freshness.firmographic.staleAfterDays) ||
    !isRecord(freshness.contact) || !sameKeys(freshness.contact, ["freshThroughDays", "manualReviewAfterDays"]) || !days(freshness.contact.freshThroughDays) || !days(freshness.contact.manualReviewAfterDays) || Number(freshness.contact.freshThroughDays) >= Number(freshness.contact.manualReviewAfterDays) ||
    !isRecord(freshness.writeback) || !sameKeys(freshness.writeback, ["eligibleThroughDays"]) || !days(freshness.writeback.eligibleThroughDays) || Number(freshness.writeback.eligibleThroughDays) > Number(freshness.firmographic.freshThroughDays)) {
    fail("freshness thresholds must be nonnegative whole days in safe order");
  }

  if (!isRecord(value.sourcePolicy) || !sameKeys(value.sourcePolicy, ["approvedSourceTypes", "precedence"])) fail("approved source types are invalid");
  const sourcePolicy = value.sourcePolicy;
  if (!uniqueStrings(sourcePolicy.approvedSourceTypes) || sourcePolicy.approvedSourceTypes.some((source) => !sourceTypes.includes(source as SourceType))) fail("approved source types are invalid");
  const approvedSourceTypes = sourcePolicy.approvedSourceTypes;
  if (!isRecord(sourcePolicy.precedence) || !sameKeys(sourcePolicy.precedence, sourceFamilies)) fail("source precedence is incomplete");
  const precedenceByFamily = sourcePolicy.precedence;
  for (const family of sourceFamilies) {
    const precedence = precedenceByFamily[family];
    if (!uniqueStrings(precedence) || precedence.length === 0 || precedence.some((source) => !approvedSourceTypes.includes(source))) fail(`${family} precedence must contain unique approved sources`);
  }
  for (const family of ["workflow", "association", "duplicate", "firmographic", "contact"] as const) {
    if ((precedenceByFamily[family] as string[])[0] !== "crm") fail(`CRM must remain authoritative for ${family}`);
  }
  for (const [family, required] of [["intent", "intent"], ["engagement", "engagement"], ["publicSignal", "public_signal"]] as const) {
    if ((precedenceByFamily[family] as string[])[0] !== required) fail(`${required} must lead ${family} precedence`);
  }

  if (!isRecord(value.weakSignals) || !sameKeys(value.weakSignals, ["emailOpens"]) || !isRecord(value.weakSignals.emailOpens) || !sameKeys(value.weakSignals.emailOpens, ["sourceType", "countsAsBuyingIntent", "canProduceHotAlone"]) || value.weakSignals.emailOpens.sourceType !== "engagement" || value.weakSignals.emailOpens.countsAsBuyingIntent !== false || value.weakSignals.emailOpens.canProduceHotAlone !== false) fail("email opens must remain weak engagement and cannot produce Hot alone");

  if (!isRecord(value.writeback) || !sameKeys(value.writeback, ["minimumConfidence", "approvedSourceTypes", "allowlist", "blockedFields"]) || value.writeback.minimumConfidence !== "High") fail("writeback safety rules are incomplete");
  const writeback = value.writeback;
  if (!uniqueStrings(writeback.approvedSourceTypes) || writeback.approvedSourceTypes.length === 0 || writeback.approvedSourceTypes.some((source) => !approvedSourceTypes.includes(source))) fail("writeback safety rules are incomplete");
  const blockedFields = writeback.blockedFields;
  if (!uniqueStrings(blockedFields) || permanentlyBlockedWritebackFields.some((field) => !blockedFields.includes(field))) fail("writeback safety rules are incomplete");
  if (!isRecord(writeback.allowlist) || !sameKeys(writeback.allowlist, ["contact", "company"])) fail("writeback allowlist must be grouped by contact and company");
  const allowlistByObject = writeback.allowlist;
  for (const object of ["contact", "company"] as const) {
    const allowlist = allowlistByObject[object];
    const canonical = canonicalWritebackFields[object] as readonly string[];
    if (!uniqueStrings(allowlist) || allowlist.some((field) => !canonical.includes(field) || blockedFields.includes(field))) fail(`${object} writeback allowlist contains an unsafe field`);
  }
}

const versionKeys = ["id", "author", "createdAt", "status", "changeSummary", "adminNotes", "config"] as const;
export function assertConfigVersion(value: unknown): asserts value is ScoringConfigVersion {
  if (!isRecord(value) || !sameKeys(value, versionKeys) ||
    ![value.id, value.author, value.changeSummary].every((item) => typeof item === "string" && item.trim().length > 0) ||
    typeof value.adminNotes !== "string" || typeof value.createdAt !== "string" || !Number.isFinite(Date.parse(value.createdAt)) ||
    !(["draft", "active", "inactive"] as unknown[]).includes(value.status)) fail("version metadata is invalid");
  assertScoringConfig(value.config);
}

export const createConfigDraft = (input: Omit<ScoringConfigVersion, "status">): ScoringConfigVersion => {
  const draft = { ...input, status: "draft" };
  assertConfigVersion(draft);
  return immutable(draft);
};

export const compareConfigs = (before: ScoringConfig, after: ScoringConfig): readonly ConfigSection[] => {
  assertScoringConfig(before);
  assertScoringConfig(after);
  return immutable(configSections.filter((section) => JSON.stringify(before[section]) !== JSON.stringify(after[section])));
};

const assertPublishedCatalog = (versions: readonly ScoringConfigVersion[], allowEmpty: boolean) => {
  const ids = new Set<string>();
  for (const version of versions) {
    assertConfigVersion(version);
    if (version.status === "draft") fail("published catalogs cannot contain drafts");
    if (ids.has(version.id)) fail("version IDs must be unique");
    ids.add(version.id);
  }
  const active = versions.filter((version) => version.status === "active");
  if ((!allowEmpty || versions.length > 0) && active.length !== 1) fail("published catalogs require exactly one active version");
};

export const publishConfigDraft = (versions: readonly ScoringConfigVersion[], draft: ScoringConfigVersion): readonly ScoringConfigVersion[] => {
  assertPublishedCatalog(versions, true);
  assertConfigVersion(draft);
  if (draft.status !== "draft") fail("only a draft can be published");
  if (versions.some((version) => version.id === draft.id)) fail("version IDs must be unique");
  return immutable([
    ...versions.map((version) => ({ ...version, status: version.status === "active" ? "inactive" as const : version.status })),
    { ...draft, status: "active" as const }
  ]);
};

export const selectActiveConfig = (versions: readonly ScoringConfigVersion[]): ScoringConfigVersion => {
  assertPublishedCatalog(versions, false);
  return immutable(versions.find((version) => version.status === "active") as ScoringConfigVersion);
};

export const createScoringRunContext = (version: ScoringConfigVersion): ScoringRunContext => {
  assertConfigVersion(version);
  if (version.status !== "active") fail("scoring requires an active config version");
  return immutable({ score_version: version.id, config: version.config });
};

export const defaultScoringConfig: ScoringConfig = immutable({
  categoryWeights: { icp_fit: 30, high_intent_actions: 25, engagement_quality: 15, public_timing_signals: 15, crm_process_context: 10, data_confidence: 5 },
  bandThresholds: { Cold: 0, Warm: 60, Hot: 80 },
  confidenceRules: {
    high: { requiredDataPresent: true, keySourcesFresh: true, materialConflictsAllowed: false },
    medium: { requiredDataPresent: true, optionalDataMayBeMissing: true, maxNonKeyStaleSources: 1, limitedSignalsAllowed: true, materialConflictsAllowed: false },
    low: { fallbackWhenHigherRulesFail: true }
  },
  manualReview: { priorityBand: "Needs Manual Review", priorityScore: null, confidence: "Low", precedesNumericBands: true, triggers: manualReviewTriggers },
  freshness: {
    intent: { freshThroughDays: 30 },
    engagement: { freshThroughDays: 30 },
    publicSignal: { freshThroughDays: 90 },
    firmographic: { freshThroughDays: 90, staleAfterDays: 180 },
    contact: { freshThroughDays: 90, manualReviewAfterDays: 180 },
    writeback: { eligibleThroughDays: 90 }
  },
  sourcePolicy: {
    approvedSourceTypes: sourceTypes,
    precedence: {
      workflow: ["crm"],
      association: ["crm"],
      duplicate: ["crm"],
      firmographic: ["crm", "enrichment"],
      contact: ["crm", "enrichment"],
      intent: ["intent"],
      engagement: ["engagement"],
      publicSignal: ["public_signal"]
    }
  },
  weakSignals: { emailOpens: { sourceType: "engagement", countsAsBuyingIntent: false, canProduceHotAlone: false } },
  writeback: {
    minimumConfidence: "High",
    approvedSourceTypes: ["enrichment", "public_signal"],
    allowlist: { contact: [...canonicalWritebackFields.contact], company: [...canonicalWritebackFields.company] },
    blockedFields: [...permanentlyBlockedWritebackFields]
  }
});

export const defaultConfigVersion: ScoringConfigVersion = immutable({
  id: "score-v0.1",
  author: "ContextAI",
  createdAt: "2026-07-11T00:00:00.000Z",
  status: "active",
  changeSummary: "Lock the v0 scoring and writeback policy defaults.",
  adminNotes: "The default thresholds classify 54/100 as Cold.",
  config: defaultScoringConfig
});

export const configBoundaryFixtures = immutable({
  scoreBands: [
    { score: 0, expectedBand: "Cold" },
    { score: 54, expectedBand: "Cold" },
    { score: 59, expectedBand: "Cold" },
    { score: 60, expectedBand: "Warm" },
    { score: 79, expectedBand: "Warm" },
    { score: 80, expectedBand: "Hot" },
    { score: 100, expectedBand: "Hot" }
  ] as const,
  freshness: [
    { policy: "intent", daysOld: 30, eligible: true },
    { policy: "intent", daysOld: 31, eligible: false },
    { policy: "publicSignal", daysOld: 90, eligible: true },
    { policy: "publicSignal", daysOld: 91, eligible: false },
    { policy: "writeback", daysOld: 90, eligible: true },
    { policy: "writeback", daysOld: 91, eligible: false }
  ] as const
});

export const invalidConfigFixtures: Readonly<Record<string, unknown>> = immutable({
  weightOutOfRange: { ...defaultScoringConfig, categoryWeights: { ...defaultScoringConfig.categoryWeights, icp_fit: -1, high_intent_actions: 56 } },
  weightTotal: { ...defaultScoringConfig, categoryWeights: { ...defaultScoringConfig.categoryWeights, data_confidence: 4 } },
  bandOrder: { ...defaultScoringConfig, bandThresholds: { Cold: 0, Warm: 80, Hot: 80 } },
  bandOutOfRange: { ...defaultScoringConfig, bandThresholds: { Cold: 0, Warm: 60, Hot: 101 } },
  freshnessRange: { ...defaultScoringConfig, freshness: { ...defaultScoringConfig.freshness, intent: { freshThroughDays: -1 } } },
  freshnessRelationship: { ...defaultScoringConfig, freshness: { ...defaultScoringConfig.freshness, firmographic: { freshThroughDays: 180, staleAfterDays: 180 } } },
  manualReviewSafety: { ...defaultScoringConfig, manualReview: { ...defaultScoringConfig.manualReview, precedesNumericBands: false } },
  sourcePrecedence: { ...defaultScoringConfig, sourcePolicy: { ...defaultScoringConfig.sourcePolicy, precedence: { ...defaultScoringConfig.sourcePolicy.precedence, workflow: ["enrichment", "crm"] } } },
  weakOpens: { ...defaultScoringConfig, weakSignals: { emailOpens: { ...defaultScoringConfig.weakSignals.emailOpens, canProduceHotAlone: true } } },
  blockedWriteback: { ...defaultScoringConfig, writeback: { ...defaultScoringConfig.writeback, allowlist: { ...defaultScoringConfig.writeback.allowlist, contact: [...defaultScoringConfig.writeback.allowlist.contact, "owner"] } } },
  missingPermanentBlock: { ...defaultScoringConfig, writeback: { ...defaultScoringConfig.writeback, blockedFields: defaultScoringConfig.writeback.blockedFields.filter((field) => field !== "owner") } },
  noApprovedWritebackSource: { ...defaultScoringConfig, writeback: { ...defaultScoringConfig.writeback, approvedSourceTypes: [] } }
});
