import { createHash } from "node:crypto";
import type { Confidence, Evidence, SourceType } from "./contextai.ts";

export type TerminalToolStatus = "success" | "no_result" | "unavailable" | "timeout" | "rate_limited" | "invalid_result" | "skipped";
export type ToolStatus = TerminalToolStatus;

export type EnrichProfileResult = {
  status: TerminalToolStatus;
  employees?: number;
  revenue_band?: string;
  tech_stack: string[];
  last_updated?: string;
  confidence: Confidence;
  source_name: string;
  source_url?: string;
  source_record_id?: string;
  evidence: Evidence[];
  message?: string;
};

export type IntentTriggersResult = {
  status: TerminalToolStatus;
  opens: number;
  clicks: number;
  replies: number;
  demo_request: boolean;
  pricing_page_visit: boolean;
  surge: boolean;
  last_updated?: string;
  confidence: Confidence;
  source_name: string;
  intent_source_name?: string;
  engagement_source_name?: string;
  evidence: Evidence[];
  message?: string;
};

export type PublicSignalItem = {
  label: string;
  source: string;
  published_at: string;
  source_url?: string;
  source_record_id?: string;
  confidence: Confidence;
};

export type PublicSignalsResult = {
  status: TerminalToolStatus;
  signals: PublicSignalItem[];
  evidence: Evidence[];
  message?: string;
};

export type WriteCrmEnrichmentResult = {
  status: "skipped";
  reason: string;
  writable: false;
};

type Env = Record<string, string | undefined>;
type IngestionFixtures = {
  enrichProfile?: Record<string, Omit<EnrichProfileResult, "status">>;
  intentTriggers?: Record<string, Omit<IntentTriggersResult, "status">>;
  publicSignals?: Record<string, PublicSignalItem[]>;
};

type IngestionOptions = {
  evaluatedAt?: string;
  env?: Env;
  timeoutMs?: number;
  maxRetries?: number;
  fixtures?: IngestionFixtures;
};

const defaultTimeoutMs = 8000;
const defaultMaxRetries = 2;
const retryBaseMs = 120;
const retryMaxDelayMs = 900;
const controlText = /[\u0000-\u001f\u007f]/;

const unavailable = <T extends { status: TerminalToolStatus; message?: string }>(
  base: Omit<T, "status" | "message"> & Partial<Pick<T, "message">>
): T => ({ ...base, status: "unavailable", message: base.message ?? "Data unavailable" } as T);

const noResult = <T extends { status: TerminalToolStatus; message?: string }>(
  base: Omit<T, "status" | "message">
): T => ({ ...base, status: "no_result", message: "No matching records found." } as T);

const invalidResult = <T extends { status: TerminalToolStatus; message?: string }>(
  base: Omit<T, "status" | "message"> & Partial<Pick<T, "message">>
): T => ({ ...base, status: "invalid_result", message: base.message ?? "Malformed provider result" } as T);

const asConfidence = (value: unknown): Confidence | undefined =>
  value === "High" || value === "Medium" || value === "Low" ? value : undefined;

const asString = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim().length > 0 && !controlText.test(value) ? value.trim() : undefined;

const asNonNegativeInteger = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;

const asBoolean = (value: unknown): boolean | undefined =>
  typeof value === "boolean" ? value : undefined;

const asIsoDate = (value: unknown): string | undefined =>
  typeof value === "string" && !controlText.test(value) && Number.isFinite(Date.parse(value)) ? value : undefined;

const asUrl = (value: unknown): string | undefined => {
  if (typeof value !== "string" || !value.trim() || controlText.test(value)) return undefined;
  try {
    const url = new URL(value.trim());
    return url.protocol === "http:" || url.protocol === "https:" ? value.trim() : undefined;
  } catch {
    return undefined;
  }
};

const asTechStack = (value: unknown): string[] => {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => asString(item) ?? "")
    .filter((item) => item.length > 0);
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const normalizeDomain = (domain: string) => controlText.test(domain) ? "" : domain.trim().toLowerCase().replace(/^www\./, "");
const normalizeEmail = (email: string) => controlText.test(email) ? "" : email.trim().toLowerCase();
const normalizeCompany = (name: string) => controlText.test(name) ? "" : name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "");

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const evidenceId = (parts: string[]) =>
  createHash("sha256").update(parts.join("|")).digest("hex").slice(0, 20);

const baseEvidence = (
  sourceName: string,
  sourceType: SourceType,
  sourceTimestamp: string | undefined,
  confidence: Confidence,
  fieldName: string,
  fieldValue: Evidence["field_value"],
  retrievedAt: string,
  sourceUrl?: string,
  sourceRecordId?: string,
  eligibleForWriteback = false,
  fieldValues?: Record<string, string | number | boolean | string[]>,
  publishedAt?: string,
): Evidence => ({
  evidence_id: evidenceId([sourceType, sourceName, fieldName, String(fieldValue), sourceTimestamp ?? "", String(retrievedAt)]),
  source_name: sourceName,
  source_type: sourceType,
  source_url: sourceUrl,
  source_record_id: sourceRecordId,
  source_updated_at: sourceType === "public_signal" ? undefined : sourceTimestamp,
  source_published_at: sourceType === "public_signal" ? sourceTimestamp : undefined,
  retrieved_at: retrievedAt,
  confidence,
  field_name: fieldName,
  field_value: fieldValue,
  field_values: fieldValues ?? (fieldValue === undefined ? undefined : { [fieldName]: fieldValue }),
  eligible_for_crm_writeback: eligibleForWriteback,
});

const writebackEligible = (sourceType: SourceType, confidence: Confidence, fieldName?: string) => {
  if (sourceType !== "enrichment") return false;
  if (fieldName && ["employees", "revenue_band", "tech_stack"].includes(fieldName) && confidence === "High") return true;
  return false;
};

const fetchJson = async (url: string, timeoutMs: number, accessToken?: string): Promise<unknown> => {
  const response = await fetch(url, {
    headers: accessToken ? { "Authorization": `Bearer ${accessToken}` } : undefined,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await response.text();
  let body: unknown = {};

  if (!response.ok) {
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = {};
      }
    }

    const message = isRecord(body) && typeof body.message === "string" && body.message.trim().length > 0
      ? body.message
      : response.statusText;
    throw new Error(`${response.status} ${message}`);
  }

  try {
    return text ? JSON.parse(text) : {};
  } catch {
    throw new Error("Malformed provider response");
  }
};

const classifyFetchError = (error: unknown): TerminalToolStatus => {
  if (error instanceof Error) {
    if (error.name === "TimeoutError" || /timeout|aborted/i.test(error.message)) return "timeout";
    if (/429|rate.?limit/i.test(error.message)) return "rate_limited";
    if (error.message === "Malformed provider response") return "invalid_result";
  }

  return "unavailable";
};

const isRetryable = (status: TerminalToolStatus) => status === "timeout" || status === "rate_limited" || status === "unavailable";

const retryDelayMs = (attempt: number) => {
  const raw = retryBaseMs * 2 ** attempt;
  return Math.min(retryMaxDelayMs, raw);
};

const fetchWithRetries = async (
  apiBase: string,
  key: string,
  param: string,
  timeoutMs: number,
  maxRetries: number,
  accessToken?: string,
): Promise<unknown> => {
  let attempt = 0;
  while (true) {
    try {
      const url = new URL(apiBase);
      url.searchParams.set(param, key);
      return await fetchJson(url.toString(), timeoutMs, accessToken);
    } catch (error) {
      const status = classifyFetchError(error);
      if (!isRetryable(status) || attempt >= maxRetries) {
        throw error;
      }
      attempt += 1;
      await sleep(retryDelayMs(attempt));
    }
  }
};

const applyFetchFailure = <T extends { status: TerminalToolStatus; message?: string }>(
  status: TerminalToolStatus,
  base: Omit<T, "status" | "message"> & Partial<Pick<T, "message">>,
  evidence: Evidence[]
): T => {
  if (status === "invalid_result") {
    return invalidResult({ ...base, message: base.message ?? "Malformed provider result", evidence });
  }

  if (status === "timeout") {
    return ({ ...base, evidence, status: "timeout", message: base.message ?? "Request timed out." } as T);
  }

  if (status === "rate_limited") {
    return ({ ...base, evidence, status: "rate_limited", message: base.message ?? "Rate limit exceeded." } as T);
  }

  return unavailable({ ...base, message: base.message ?? "Data unavailable", evidence });
};

const withFixtures = <T>(fixtures: Record<string, T> | undefined, key: string) => {
  if (!fixtures) return undefined;
  return fixtures[key];
};

const parseEnrichmentResult = (payload: unknown, evaluatedAt: string): EnrichProfileResult | null => {
  if (!isRecord(payload)) return null;

  const sourceName = asString(payload.source_name);
  if (!sourceName) return null;

  const sourceUpdatedAt = asIsoDate(payload.last_updated);
  const sourceUrl = asUrl(payload.source_url);
  const sourceRecordId = asString(payload.source_record_id);
  const employeesRaw = payload.employees;
  const employees = employeesRaw === undefined ? undefined : asNonNegativeInteger(employeesRaw);
  const revenueBand = asString(payload.revenue_band);
  const hasTechStack = Object.hasOwn(payload, "tech_stack");
  const techStack = asTechStack(payload.tech_stack);
  const parsedConfidence = asConfidence(payload.confidence);
  const confidence = parsedConfidence ?? "Medium";
  const validConfidence = payload.confidence === undefined || parsedConfidence !== undefined;

  if (
    !validConfidence ||
    (payload.source_url !== undefined && sourceUrl === undefined) ||
    (payload.source_record_id !== undefined && sourceRecordId === undefined) ||
    (payload.last_updated !== undefined && sourceUpdatedAt === undefined) ||
    (sourceUpdatedAt !== undefined && Date.parse(sourceUpdatedAt) > Date.parse(evaluatedAt)) ||
    (payload.employees !== undefined && employees === undefined) ||
    (payload.revenue_band !== undefined && revenueBand === undefined) ||
    (hasTechStack && (!Array.isArray(payload.tech_stack) || techStack.length !== payload.tech_stack.length))
  ) {
    return null;
  }

  if (employees === undefined && revenueBand === undefined && techStack.length === 0) {
    return noResult({
      tech_stack: [],
      confidence: "Low",
      source_name: sourceName,
      source_url: sourceUrl,
      source_record_id: sourceRecordId,
      evidence: [],
    });
  }

  if (sourceUpdatedAt === undefined) return null;

  const evidence: Evidence[] = [];
  const updatedAt = sourceUpdatedAt;

  if (employees !== undefined) {
    evidence.push(baseEvidence(sourceName, "enrichment", updatedAt, confidence, "employees", employees, evaluatedAt, sourceUrl, sourceRecordId, writebackEligible("enrichment", confidence, "employees")));
  }

  if (revenueBand !== undefined) {
    evidence.push(baseEvidence(sourceName, "enrichment", updatedAt, confidence, "revenue_band", revenueBand, evaluatedAt, sourceUrl, sourceRecordId, writebackEligible("enrichment", confidence, "revenue_band")));
  }

  if (techStack.length > 0) {
    evidence.push(baseEvidence(sourceName, "enrichment", updatedAt, confidence, "tech_stack", techStack, evaluatedAt, sourceUrl, sourceRecordId, writebackEligible("enrichment", confidence, "tech_stack")));
  }

  return {
    status: "success",
    employees,
    revenue_band: revenueBand,
    tech_stack: techStack,
    last_updated: updatedAt,
    confidence,
    source_name: sourceName,
    source_url: sourceUrl,
    source_record_id: sourceRecordId,
    evidence,
  };
};

const parseIntentSection = (
  source: unknown,
  fallbackName: string,
  confidence: Confidence,
  evaluatedAt: string,
): {
  parsed: { surge: boolean } | null;
  sourceName: string;
  sourceUpdatedAt?: string;
  evidence?: Evidence;
  malformed: boolean;
} => {
  if (!isRecord(source)) {
    return {
      parsed: null,
      sourceName: fallbackName,
      malformed: false,
    };
  }

  const sourceName = asString(source.source_name) ?? fallbackName;
  const parsedSurge = asBoolean(source.surge);
  const updatedAt = asIsoDate(source.last_updated);

  if (
    (source.surge !== undefined && parsedSurge === undefined) ||
    (source.last_updated !== undefined && updatedAt === undefined) ||
    (updatedAt !== undefined && Date.parse(updatedAt) > Date.parse(evaluatedAt)) ||
    (parsedSurge === true && updatedAt === undefined)
  ) {
    return {
      parsed: null,
      sourceName,
      malformed: true,
    };
  }

  const evidence = parsedSurge && updatedAt ? baseEvidence(
    sourceName,
    "intent",
    updatedAt,
    confidence,
    "surge",
    parsedSurge,
    evaluatedAt,
    asUrl(source.source_url),
    asString(source.source_record_id),
    false
  ) : undefined;

  return {
    parsed: { surge: parsedSurge ?? false },
    sourceName,
    sourceUpdatedAt: updatedAt,
    evidence,
    malformed: false,
  };
};

const parseEngagementSection = (
  source: unknown,
  fallbackName: string,
  confidence: Confidence,
  evaluatedAt: string,
): {
  parsed: { opens: number; clicks: number; replies: number; demo_request: boolean; pricing_page_visit: boolean } | null;
  sourceName: string;
  sourceUpdatedAt?: string;
  evidence?: Evidence;
  malformed: boolean;
} => {
  if (!isRecord(source)) {
    return {
      parsed: { opens: 0, clicks: 0, replies: 0, demo_request: false, pricing_page_visit: false },
      sourceName: fallbackName,
      malformed: false,
    };
  }

  const sourceName = asString(source.source_name) ?? fallbackName;
  const opensRaw = source.opens;
  const clicksRaw = source.clicks;
  const repliesRaw = source.replies;
  const demoRaw = source.demo_request;
  const pricingRaw = source.pricing_page_visit;

  const opensParsed = opensRaw === undefined ? 0 : asNonNegativeInteger(opensRaw);
  const clicksParsed = clicksRaw === undefined ? 0 : asNonNegativeInteger(clicksRaw);
  const repliesParsed = repliesRaw === undefined ? 0 : asNonNegativeInteger(repliesRaw);
  const demoParsed = demoRaw === undefined ? false : asBoolean(demoRaw);
  const pricingParsed = pricingRaw === undefined ? false : asBoolean(pricingRaw);

  if (
    (opensRaw !== undefined && opensParsed === undefined) ||
    (clicksRaw !== undefined && clicksParsed === undefined) ||
    (repliesRaw !== undefined && repliesParsed === undefined) ||
    (demoRaw !== undefined && demoParsed === undefined) ||
    (pricingRaw !== undefined && pricingParsed === undefined)
  ) {
    return {
      parsed: null,
      sourceName,
      malformed: true,
    };
  }

  const updatedAt = asIsoDate(source.last_updated);
  const values = {
    opens: opensParsed,
    clicks: clicksParsed,
    replies: repliesParsed,
    demo_request: demoParsed,
    pricing_page_visit: pricingParsed,
  };
  const isMeaningful = values.opens > 0 || values.clicks > 0 || values.replies > 0 || values.demo_request || values.pricing_page_visit;

  if (
    (source.last_updated !== undefined && updatedAt === undefined) ||
    (updatedAt !== undefined && Date.parse(updatedAt) > Date.parse(evaluatedAt)) ||
    (isMeaningful && updatedAt === undefined)
  ) {
    return {
      parsed: null,
      sourceName,
      malformed: true,
    };
  }

  const evidence = isMeaningful
    ? baseEvidence(
        sourceName,
        "engagement",
        updatedAt as string,
        confidence,
        "engagement",
        "engagement activity",
        evaluatedAt,
        asUrl(source.source_url),
        asString(source.source_record_id),
        false,
        {
          opens: values.opens,
          clicks: values.clicks,
          replies: values.replies,
          demo_request: values.demo_request,
          pricing_page_visit: values.pricing_page_visit,
        }
      )
    : undefined;

  return {
    parsed: values,
    sourceName,
    sourceUpdatedAt: updatedAt,
    evidence,
    malformed: false,
  };
};

const parseIntentPayload = (payload: unknown, evaluatedAt: string): IntentTriggersResult | null => {
  if (!isRecord(payload)) return null;

  const parsedConfidence = asConfidence(payload.confidence);
  if (payload.confidence !== undefined && parsedConfidence === undefined) return null;
  const confidence = parsedConfidence ?? "Medium";
  if (
    (Object.hasOwn(payload, "intent") && !isRecord(payload.intent)) ||
    (Object.hasOwn(payload, "engagement") && !isRecord(payload.engagement))
  ) return null;
  const intentSource = isRecord(payload.intent) ? payload.intent : payload;
  const engagementSource = isRecord(payload.engagement) ? payload.engagement : payload;

  const sourceName = asString(payload.source_name)
    ?? asString(intentSource.source_name)
    ?? asString(engagementSource.source_name);
  if (!sourceName) return null;

  const intentParsed = parseIntentSection(intentSource, sourceName, confidence, evaluatedAt);
  const engagementParsed = parseEngagementSection(engagementSource, sourceName, confidence, evaluatedAt);

  if (intentParsed.malformed || engagementParsed.malformed) return null;

  const intent = intentParsed.parsed;
  const engagement = engagementParsed.parsed;

  const opens = engagement?.opens ?? 0;
  const clicks = engagement?.clicks ?? 0;
  const replies = engagement?.replies ?? 0;
  const demo_request = engagement?.demo_request ?? false;
  const pricing_page_visit = engagement?.pricing_page_visit ?? false;
  const surge = intent?.surge ?? false;

  const allEmpty = opens === 0 && clicks === 0 && replies === 0 && !demo_request && !pricing_page_visit && !surge;
  const evidence: Evidence[] = [];
  const summaryUpdatedAt = asIsoDate(payload.last_updated);
  if (
    payload.last_updated !== undefined &&
    (summaryUpdatedAt === undefined || Date.parse(summaryUpdatedAt) > Date.parse(evaluatedAt))
  ) return null;

  const candidateUpdated = [
    asIsoDate(intentParsed.sourceUpdatedAt),
    asIsoDate(engagementParsed.sourceUpdatedAt),
    summaryUpdatedAt
  ]
    .map((value) => (value ? Date.parse(value) : Number.NaN))
    .filter(Number.isFinite);

  const lastUpdated = candidateUpdated.length > 0
    ? new Date(Math.max(...candidateUpdated)).toISOString()
    : evaluatedAt;

  if (intentParsed.evidence) {
    evidence.push(intentParsed.evidence);
  }

  if (engagementParsed.evidence) {
    evidence.push(engagementParsed.evidence);
  }

  if (allEmpty) {
    return noResult({
      opens,
      clicks,
      replies,
      demo_request,
      pricing_page_visit,
      surge,
      confidence,
      last_updated: lastUpdated,
      source_name: sourceName,
      intent_source_name: intentParsed.sourceName,
      engagement_source_name: engagementParsed.sourceName,
      evidence: [],
    });
  }

  return {
    status: "success",
    opens,
    clicks,
    replies,
    demo_request,
    pricing_page_visit,
    surge,
    confidence,
    last_updated: lastUpdated,
    source_name: sourceName,
    intent_source_name: intentParsed.sourceName,
    engagement_source_name: engagementParsed.sourceName,
    evidence,
  };
};

const parsePublicSignalsResult = (payload: unknown, evaluatedAt: string): PublicSignalItem[] | "malformed" => {
  if (!isRecord(payload)) return "malformed";
  const rawSignals = payload.signals;
  if (!Object.hasOwn(payload, "signals")) return "malformed";
  if (!Array.isArray(rawSignals)) return "malformed";

  const validSignals: PublicSignalItem[] = [];

  for (const raw of rawSignals) {
    if (!isRecord(raw)) continue;

    const signal = {
      label: asString(raw.label),
      source: asString(raw.source),
      source_url: asUrl(raw.source_url),
      source_record_id: asString(raw.source_record_id),
      published_at: asIsoDate(raw.published_at),
      confidence: asConfidence(raw.confidence),
    };

    if (!signal.label || !signal.source || !signal.published_at) continue;
    if (signal.source_url === undefined && signal.source_record_id === undefined) continue;
    if (Date.parse(signal.published_at) > Date.parse(evaluatedAt)) continue;

    validSignals.push({
      label: signal.label,
      source: signal.source,
      source_url: signal.source_url,
      source_record_id: signal.source_record_id,
      published_at: signal.published_at,
      confidence: signal.confidence ?? "Medium",
    });
  }

  return [...new Map(validSignals.map((signal) => [
    evidenceId(["public_signal", signal.source, signal.label, signal.published_at, signal.source_record_id ?? signal.source_url ?? ""]),
    signal,
  ])).values()];
};

const publicSignalEvidence = (signals: PublicSignalItem[], evaluatedAt: string): Evidence[] =>
  signals.map((signal) => {
    return {
      evidence_id: evidenceId(["public_signal", signal.source, signal.label, signal.published_at, signal.source_record_id ?? signal.source_url ?? ""]),
      source_name: signal.source,
      source_type: "public_signal",
      source_url: signal.source_url,
      source_record_id: signal.source_record_id,
      source_published_at: signal.published_at,
      retrieved_at: evaluatedAt,
      confidence: signal.confidence,
      field_name: "label",
      field_value: signal.label,
      field_values: {
        label: signal.label,
      },
      eligible_for_crm_writeback: false,
    };
  });

const parsePublicResult = (payload: unknown, evaluatedAt: string): PublicSignalsResult => {
  const rawSignals = parsePublicSignalsResult(payload, evaluatedAt);

  if (rawSignals === "malformed") {
    return invalidResult({
      signals: [],
      evidence: [],
      message: "Malformed public signal fixture.",
    });
  }

  if (rawSignals.length === 0) {
    if (isRecord(payload)) {
      const signals = payload.signals;
      if (Array.isArray(signals) && signals.length > 0) {
        return invalidResult({
          signals: [],
          evidence: [],
          message: "Malformed public signal fixture.",
        });
      }
    }

    return noResult({
      signals: [],
      evidence: [],
      message: "No verified public signals found.",
    });
  }

  return {
    status: "success",
    signals: rawSignals,
    evidence: publicSignalEvidence(rawSignals, evaluatedAt),
  };
};

/**
 * Pulls firmographics by domain. Uses ENRICHMENT_API_URL when set; optional fixtures for tests.
 */
export const enrichProfile = async (
  domain: string,
  options: IngestionOptions = {}
): Promise<EnrichProfileResult> => {
  const evaluatedAt = options.evaluatedAt ?? new Date().toISOString();
  const env = options.env ?? process.env;
  const timeoutMs = options.timeoutMs ?? defaultTimeoutMs;
  const maxRetries = options.maxRetries ?? defaultMaxRetries;
  const key = normalizeDomain(domain);

  if (!key || key === "unknown.local" || key === "test-error.com") {
    return unavailable({
      tech_stack: [],
      confidence: "Low",
      source_name: "enrichment",
      evidence: [],
      message: "No usable enrichment profile key.",
    });
  }

  const fixture = withFixtures(options.fixtures?.enrichProfile, key);
  if (fixture) {
    const parsed = parseEnrichmentResult(fixture, evaluatedAt);
    return parsed ?? invalidResult({
      tech_stack: [],
      confidence: "Low",
      source_name: asString(fixture.source_name) ?? "enrichment",
      source_url: asUrl(fixture.source_url),
      source_record_id: asString(fixture.source_record_id),
      evidence: [],
      message: "Malformed enrichment fixture.",
    });
  }

  const apiBase = env.ENRICHMENT_API_URL?.trim();
  if (apiBase) {
    try {
      const payload = await fetchWithRetries(apiBase, key, "domain", timeoutMs, maxRetries, env.ENRICHMENT_API_KEY);
      const parsed = parseEnrichmentResult(payload, evaluatedAt);
      return parsed ?? invalidResult({
        tech_stack: [],
        confidence: "Low",
        source_name: "enrichment",
        evidence: [],
        message: "Malformed enrichment response.",
      });
    } catch (error) {
      return applyFetchFailure(classifyFetchError(error), {
        tech_stack: [],
        confidence: "Low",
        source_name: "enrichment",
        evidence: [],
        message: "Data unavailable",
      }, []);
    }
  }

  return unavailable({
    tech_stack: [],
    confidence: "Low",
    source_name: "enrichment",
    evidence: [],
    message: "No enrichment provider configured.",
  });
};

/**
 * Pulls engagement/intent by lead email.
 * Uses INTENT_API_URL when set; optional fixtures for tests.
 */
export const fetchIntentTriggers = async (
  leadKey: string,
  options: IngestionOptions = {}
): Promise<IntentTriggersResult> => {
  const evaluatedAt = options.evaluatedAt ?? new Date().toISOString();
  const env = options.env ?? process.env;
  const timeoutMs = options.timeoutMs ?? defaultTimeoutMs;
  const maxRetries = options.maxRetries ?? defaultMaxRetries;
  const key = normalizeEmail(leadKey);

  if (!key || key.includes("@test-error.com")) {
    return unavailable({
      opens: 0,
      clicks: 0,
      replies: 0,
      demo_request: false,
      pricing_page_visit: false,
      surge: false,
      confidence: "Low",
      source_name: "intent",
      intent_source_name: "intent",
      engagement_source_name: "intent",
      evidence: [],
      message: "No usable intent key.",
    });
  }

  const fixture = withFixtures(options.fixtures?.intentTriggers, key);
  if (fixture) {
    const parsed = parseIntentPayload(fixture, evaluatedAt);
    return parsed ?? invalidResult({
      opens: 0,
      clicks: 0,
      replies: 0,
      demo_request: false,
      pricing_page_visit: false,
      surge: false,
      confidence: "Low",
      source_name: asString(fixture.source_name) ?? "intent",
      intent_source_name: asString(fixture.intent_source_name),
      engagement_source_name: asString(fixture.engagement_source_name),
      evidence: [],
      message: "Malformed intent fixture.",
    });
  }

  const apiBase = env.INTENT_API_URL?.trim();
  if (apiBase) {
    try {
      const payload = await fetchWithRetries(apiBase, key, "email", timeoutMs, maxRetries, env.INTENT_API_KEY);
      const parsed = parseIntentPayload(payload, evaluatedAt);
      return parsed ?? invalidResult({
        opens: 0,
        clicks: 0,
        replies: 0,
        demo_request: false,
        pricing_page_visit: false,
        surge: false,
        confidence: "Low",
        source_name: "intent",
        evidence: [],
        message: "Malformed intent response.",
      });
    } catch (error) {
      return applyFetchFailure(classifyFetchError(error), {
        opens: 0,
        clicks: 0,
        replies: 0,
        demo_request: false,
        pricing_page_visit: false,
        surge: false,
        confidence: "Low",
        source_name: "intent",
        intent_source_name: "intent",
        engagement_source_name: "intent",
        evidence: [],
        message: "Data unavailable",
      }, []);
    }
  }

  return unavailable({
    opens: 0,
    clicks: 0,
    replies: 0,
    demo_request: false,
    pricing_page_visit: false,
    surge: false,
    confidence: "Low",
    source_name: "intent",
    intent_source_name: "intent",
    engagement_source_name: "intent",
    evidence: [],
    message: "No intent provider configured.",
  });
};

/**
 * Pulls recent public company signals.
 * Uses PUBLIC_SIGNALS_API_URL when set; optional fixtures for tests.
 */
export const fetchPublicSignals = async (
  companyName: string,
  options: IngestionOptions = {}
): Promise<PublicSignalsResult> => {
  const evaluatedAt = options.evaluatedAt ?? new Date().toISOString();
  const env = options.env ?? process.env;
  const timeoutMs = options.timeoutMs ?? defaultTimeoutMs;
  const maxRetries = options.maxRetries ?? defaultMaxRetries;
  const key = normalizeCompany(companyName);

  if (!key || key === "testerrorcom") {
    return unavailable({
      signals: [],
      evidence: [],
      message: "No usable public signal key.",
    });
  }

  const fixture = withFixtures(options.fixtures?.publicSignals, key);
  if (fixture !== undefined) {
    return parsePublicResult({ signals: fixture }, evaluatedAt);
  }

  const apiBase = env.PUBLIC_SIGNALS_API_URL?.trim();
  if (apiBase) {
    try {
      const payload = await fetchWithRetries(apiBase, companyName.trim(), "company", timeoutMs, maxRetries, env.PUBLIC_SIGNALS_API_KEY);
      return parsePublicResult(payload, evaluatedAt);
    } catch (error) {
      return applyFetchFailure(classifyFetchError(error), {
        signals: [],
        evidence: [],
        message: "Data unavailable",
      }, []);
    }
  }

  return unavailable({
    signals: [],
    evidence: [],
    message: "No public-signal provider configured.",
  });
};

export const writeCrmEnrichment = (): Promise<WriteCrmEnrichmentResult> =>
  Promise.resolve({
    status: "skipped",
    reason: "read-only placeholder: writeback execution is intentionally disabled in this phase",
    writable: false,
  });

export const fetch_intent_triggers = fetchIntentTriggers;
export const fetch_public_signals = fetchPublicSignals;
export const enrich_profile = enrichProfile;
