import type { Confidence } from "./contextai.ts";

export type ToolStatus = "success" | "unavailable" | "timeout" | "rate_limited" | "invalid";

export type EnrichProfileResult = {
  status: ToolStatus;
  employees?: number;
  revenue_band?: string;
  tech_stack: string[];
  /** ISO timestamp used for source freshness / last_updated_days_ago */
  last_updated?: string;
  confidence: Confidence;
  source_name: string;
  source_url?: string;
  message?: string;
};

export type IntentTriggersResult = {
  status: ToolStatus;
  opens: number;
  clicks: number;
  replies: number;
  demo_request: boolean;
  pricing_page_visit: boolean;
  surge: boolean;
  /** ISO timestamp of newest intent event */
  last_updated?: string;
  confidence: Confidence;
  source_name: string;
  message?: string;
};

export type PublicSignalItem = {
  label: string;
  source: string;
  published_at: string;
  source_url: string;
  confidence: Confidence;
};

export type PublicSignalsResult = {
  status: ToolStatus;
  signals: PublicSignalItem[];
  message?: string;
};

export type WriteCrmEnrichmentResult = {
  status: "skipped";
  reason: string;
  writable: false;
};

type Env = Record<string, string | undefined>;

const dayMs = 24 * 60 * 60 * 1000;
const defaultTimeoutMs = 8000;

const unavailable = <T extends { status: ToolStatus; message?: string }>(
  base: Omit<T, "status" | "message"> & Partial<Pick<T, "message">>
): T => ({ ...base, status: "unavailable", message: base.message ?? "Data unavailable" }) as T;

const daysAgoIso = (daysAgo: number, evaluatedAt: string) =>
  new Date(Date.parse(evaluatedAt) - daysAgo * dayMs).toISOString();

/** Demo catalog for structured ingestion when live provider URLs are unset. */
const enrichCatalog: Record<string, Omit<EnrichProfileResult, "status">> = {
  "enterprisecorp.com": {
    employees: 500,
    revenue_band: "$50M-$100M",
    tech_stack: ["Salesforce"],
    last_updated: undefined,
    confidence: "High",
    source_name: "Clearbit",
  },
  "leantech.io": {
    employees: 12,
    tech_stack: [],
    last_updated: undefined,
    confidence: "Medium",
    source_name: "Apollo",
  },
  "scalegrid.example": {
    employees: 900,
    revenue_band: "$100M-$250M",
    tech_stack: ["HubSpot", "Salesforce"],
    last_updated: undefined,
    confidence: "High",
    source_name: "ZoomInfo",
  },
  "northstar.example": {
    employees: 420,
    revenue_band: "$25M-$50M",
    tech_stack: ["Salesforce"],
    last_updated: undefined,
    confidence: "High",
    source_name: "Clearbit",
  },
  "harborworks.example": {
    employees: 300,
    revenue_band: "$10M-$25M",
    tech_stack: [],
    last_updated: undefined,
    confidence: "Low",
    source_name: "Clearbit",
  },
};

const enrichAgeDays: Record<string, number> = {
  "enterprisecorp.com": 18,
  "leantech.io": 22,
  "scalegrid.example": 31,
  "northstar.example": 46,
  "harborworks.example": 420,
};

const intentCatalog: Record<string, Omit<IntentTriggersResult, "status">> = {
  "john.smith@enterprisecorp.com": {
    opens: 2,
    clicks: 1,
    replies: 0,
    demo_request: true,
    pricing_page_visit: true,
    surge: false,
    confidence: "High",
    source_name: "HubSpot",
  },
  "alice@leantech.io": {
    opens: 0,
    clicks: 0,
    replies: 0,
    demo_request: false,
    pricing_page_visit: false,
    surge: true,
    confidence: "Medium",
    source_name: "Bombora",
  },
  "priya@scalegrid.example": {
    opens: 1,
    clicks: 2,
    replies: 1,
    demo_request: true,
    pricing_page_visit: true,
    surge: false,
    confidence: "High",
    source_name: "HubSpot",
  },
  "marcus@northstar.example": {
    opens: 5,
    clicks: 0,
    replies: 0,
    demo_request: false,
    pricing_page_visit: false,
    surge: false,
    confidence: "Medium",
    source_name: "Outreach",
  },
};

const intentAgeDays: Record<string, number> = {
  "john.smith@enterprisecorp.com": 1,
  "alice@leantech.io": 2,
  "priya@scalegrid.example": 3,
  "marcus@northstar.example": 4,
};

const publicCatalog: Record<string, PublicSignalItem[]> = {
  enterprisecorp: [
    {
      label: "Series B funding announced",
      source: "Crunchbase",
      published_at: "",
      source_url: "https://example.com/enterprisecorp-series-b",
      confidence: "High",
    },
  ],
};

const publicAgeDays: Record<string, number> = {
  enterprisecorp: 8,
};

const normalizeDomain = (domain: string) => domain.trim().toLowerCase().replace(/^www\./, "");
const normalizeEmail = (email: string) => email.trim().toLowerCase();
const normalizeCompany = (name: string) => name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "");

const fetchJson = async <T>(url: string, timeoutMs: number): Promise<T> => {
  const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  const text = await response.text();
  const body = text ? JSON.parse(text) : {};
  if (!response.ok) {
    const message = typeof body.message === "string" ? body.message : response.statusText;
    throw new Error(`${response.status} ${message}`);
  }
  return body as T;
};

const classifyFetchError = (error: unknown): ToolStatus => {
  if (error instanceof Error) {
    if (error.name === "TimeoutError" || /timeout|aborted/i.test(error.message)) return "timeout";
    if (/429|rate.?limit/i.test(error.message)) return "rate_limited";
  }
  return "unavailable";
};

/**
 * Pulls firmographics by domain. Uses ENRICHMENT_API_URL when set; otherwise structured catalog.
 * Missing/timeout → status unavailable, message "Data unavailable".
 */
export const enrichProfile = async (
  domain: string,
  options: { evaluatedAt?: string; env?: Env; timeoutMs?: number } = {}
): Promise<EnrichProfileResult> => {
  const evaluatedAt = options.evaluatedAt ?? new Date().toISOString();
  const env = options.env ?? process.env;
  const timeoutMs = options.timeoutMs ?? defaultTimeoutMs;
  const key = normalizeDomain(domain);

  if (!key || key === "unknown.local" || key === "test-error.com") {
    return unavailable({
      tech_stack: [],
      confidence: "Low",
      source_name: "enrichment",
    });
  }

  const apiBase = env.ENRICHMENT_API_URL?.trim();
  if (apiBase) {
    try {
      const url = new URL(apiBase);
      url.searchParams.set("domain", key);
      const payload = await fetchJson<{
        employees?: number;
        revenue_band?: string;
        tech_stack?: string[];
        last_updated?: string;
        confidence?: Confidence;
        source_name?: string;
        source_url?: string;
      }>(url.toString(), timeoutMs);

      if (typeof payload.employees !== "number" && !payload.revenue_band && !(payload.tech_stack?.length)) {
        return unavailable({
          tech_stack: [],
          confidence: "Low",
          source_name: payload.source_name ?? "enrichment",
        });
      }

      return {
        status: "success",
        employees: typeof payload.employees === "number" ? payload.employees : undefined,
        revenue_band: payload.revenue_band,
        tech_stack: Array.isArray(payload.tech_stack) ? payload.tech_stack.filter((t) => typeof t === "string") : [],
        last_updated: payload.last_updated ?? evaluatedAt,
        confidence: payload.confidence ?? "Medium",
        source_name: payload.source_name ?? "enrichment",
        source_url: payload.source_url,
      };
    } catch (error) {
      return {
        status: classifyFetchError(error),
        tech_stack: [],
        confidence: "Low",
        source_name: "enrichment",
        message: "Data unavailable",
      };
    }
  }

  const catalog = enrichCatalog[key];
  if (!catalog) {
    return unavailable({ tech_stack: [], confidence: "Low", source_name: "enrichment" });
  }

  const age = enrichAgeDays[key] ?? 30;
  return {
    status: "success",
    ...catalog,
    last_updated: daysAgoIso(age, evaluatedAt),
  };
};

/**
 * Pulls engagement/intent by lead email (or lead_id when email unknown).
 * Uses INTENT_API_URL when set; otherwise structured catalog.
 */
export const fetchIntentTriggers = async (
  leadKey: string,
  options: { evaluatedAt?: string; env?: Env; timeoutMs?: number } = {}
): Promise<IntentTriggersResult> => {
  const evaluatedAt = options.evaluatedAt ?? new Date().toISOString();
  const env = options.env ?? process.env;
  const timeoutMs = options.timeoutMs ?? defaultTimeoutMs;
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
    });
  }

  const apiBase = env.INTENT_API_URL?.trim();
  if (apiBase) {
    try {
      const url = new URL(apiBase);
      url.searchParams.set("email", key);
      const payload = await fetchJson<{
        opens?: number;
        clicks?: number;
        replies?: number;
        demo_request?: boolean;
        pricing_page_visit?: boolean;
        surge?: boolean;
        last_updated?: string;
        confidence?: Confidence;
        source_name?: string;
      }>(url.toString(), timeoutMs);

      return {
        status: "success",
        opens: Number.isFinite(payload.opens) ? Math.max(0, Math.floor(payload.opens!)) : 0,
        clicks: Number.isFinite(payload.clicks) ? Math.max(0, Math.floor(payload.clicks!)) : 0,
        replies: Number.isFinite(payload.replies) ? Math.max(0, Math.floor(payload.replies!)) : 0,
        demo_request: Boolean(payload.demo_request),
        pricing_page_visit: Boolean(payload.pricing_page_visit),
        surge: Boolean(payload.surge),
        last_updated: payload.last_updated ?? evaluatedAt,
        confidence: payload.confidence ?? "Medium",
        source_name: payload.source_name ?? "intent",
      };
    } catch (error) {
      return {
        status: classifyFetchError(error),
        opens: 0,
        clicks: 0,
        replies: 0,
        demo_request: false,
        pricing_page_visit: false,
        surge: false,
        confidence: "Low",
        source_name: "intent",
        message: "Data unavailable",
      };
    }
  }

  const catalog = intentCatalog[key];
  if (!catalog) {
    return unavailable({
      opens: 0,
      clicks: 0,
      replies: 0,
      demo_request: false,
      pricing_page_visit: false,
      surge: false,
      confidence: "Low",
      source_name: "intent",
    });
  }

  return {
    status: "success",
    ...catalog,
    last_updated: daysAgoIso(intentAgeDays[key] ?? 3, evaluatedAt),
  };
};

/**
 * Pulls recent public company signals. Uses PUBLIC_SIGNALS_API_URL when set; otherwise catalog.
 */
export const fetchPublicSignals = async (
  companyName: string,
  options: { evaluatedAt?: string; env?: Env; timeoutMs?: number } = {}
): Promise<PublicSignalsResult> => {
  const evaluatedAt = options.evaluatedAt ?? new Date().toISOString();
  const env = options.env ?? process.env;
  const timeoutMs = options.timeoutMs ?? defaultTimeoutMs;
  const key = normalizeCompany(companyName);

  if (!key || key === "testerrorcom") {
    return unavailable({ signals: [] });
  }

  const apiBase = env.PUBLIC_SIGNALS_API_URL?.trim();
  if (apiBase) {
    try {
      const url = new URL(apiBase);
      url.searchParams.set("company", companyName.trim());
      const payload = await fetchJson<{
        signals?: Array<{
          label?: string;
          source?: string;
          published_at?: string;
          source_url?: string;
          confidence?: Confidence;
        }>;
      }>(url.toString(), timeoutMs);

      const signals = (payload.signals ?? [])
        .filter((item) => item.label && item.source && item.published_at && item.source_url)
        .map((item) => ({
          label: String(item.label),
          source: String(item.source),
          published_at: String(item.published_at),
          source_url: String(item.source_url),
          confidence: item.confidence ?? ("Medium" as Confidence),
        }));

      if (signals.length === 0) return unavailable({ signals: [] });
      return { status: "success", signals };
    } catch (error) {
      return { status: classifyFetchError(error), signals: [], message: "Data unavailable" };
    }
  }

  const catalog = publicCatalog[key];
  if (!catalog?.length) return unavailable({ signals: [] });

  const age = publicAgeDays[key] ?? 14;
  return {
    status: "success",
    signals: catalog.map((signal) => ({
      ...signal,
      published_at: signal.published_at || daysAgoIso(age, evaluatedAt),
    })),
  };
};

/**
 * Read-only placeholder. Never PATCHes HubSpot. Writeback policy deferred.
 */
export const writeCrmEnrichment = async (
  _leadId: string,
  _fields: Record<string, string> = {}
): Promise<WriteCrmEnrichmentResult> => ({
  status: "skipped",
  reason: "Writeback disabled — read-only placeholder. No HubSpot write performed.",
  writable: false,
});

/** PRD Section 3a tool names */
export const enrich_profile = enrichProfile;
export const fetch_intent_triggers = fetchIntentTriggers;
export const fetch_public_signals = fetchPublicSignals;
export const write_crm_enrichment = writeCrmEnrichment;
