import assert from "node:assert/strict";
import test from "node:test";
import {
  enrich_profile,
  enrichProfile,
  fetchIntentTriggers,
  fetchPublicSignals,
  writeCrmEnrichment,
} from "../src/lib/ingestion.ts";

const evaluatedAt = "2026-07-09T09:00:00.000Z";

test("contract-named enrichment export is available", () => {
  assert.equal(enrich_profile, enrichProfile);
});
const fixtures = {
  enrichProfile: {
    "enterprisecorp.com": {
      source_name: "Clearbit",
      employees: 500,
      revenue_band: "$50M-$100M",
      tech_stack: ["Salesforce"],
      last_updated: "2026-07-01T09:00:00.000Z",
      confidence: "High",
    },
    "lean-tech.co": {
      source_name: "NoDataCatalog",
      tech_stack: [],
    },
    "bad-enrich.co": {
      source_name: "",
      employees: "invalid",
      revenue_band: "$10M-$25M",
      tech_stack: ["Salesforce"],
    },
  },
  intentTriggers: {
    "john.smith@enterprisecorp.com": {
      source_name: "Mixed Signals",
      intent: {
        source_name: "IntentStream",
        surge: true,
        last_updated: "2026-07-05T09:00:00.000Z",
      },
      engagement: {
        source_name: "HubSpot",
        opens: 2,
        clicks: 1,
        replies: 1,
        demo_request: true,
        pricing_page_visit: true,
        last_updated: "2026-07-08T09:00:00.000Z",
      },
      confidence: "High",
    },
    "quiet@enterprisecorp.com": {
      source_name: "No Signals",
      intent: {
        source_name: "IntentStream",
        surge: false,
      },
      engagement: {
        source_name: "HubSpot",
        opens: 0,
        clicks: 0,
        replies: 0,
        demo_request: false,
        pricing_page_visit: false,
      },
    },
    "bad-intent@enterprisecorp.com": {
      source_name: "Malformed Fixture",
      engagement: {
        source_name: "HubSpot",
        opens: "two",
      },
    },
  },
  publicSignals: {
    enterprisecorp: [{
      label: "Series B funding announced",
      source: "Crunchbase",
      source_record_id: "cb-enterprisecorp-b",
      published_at: "2026-07-01T09:00:00.000Z",
    }],
    emptysignals: [],
    badsignals: [{
      label: "Broken signal",
      source: "Crunchbase",
      source_record_id: "cb-bad-signals",
    }],
    partialsignals: [
      {
        label: "Series A announced",
        source: "TechCrunch",
        source_record_id: "cb-partial-a",
        published_at: "2026-06-10T09:00:00.000Z",
        confidence: "High",
      },
      {
        label: 123,
        source: "Crunchbase",
        source_record_id: "cb-bad-label",
        published_at: "2026-06-11T09:00:00.000Z",
      },
      {
        source: "Crunchbase",
        source_record_id: "cb-missing-label",
        published_at: "2026-06-12T09:00:00.000Z",
      },
      {
        label: "No evidence id",
        source: "BadSource",
        published_at: "2026-06-13T09:00:00.000Z",
      },
    ],
    stalesignal: [{
      label: "Legacy partnership announced",
      source: "Crunchbase",
      source_record_id: "cb-stale-legacy",
      published_at: "2025-01-01T09:00:00.000Z",
    }],
  },
} as const;

test("enrich_profile accepts fixture and returns validated data", async () => {
  const result = await enrichProfile("enterprisecorp.com", {
    evaluatedAt,
    fixtures,
  });
  assert.equal(result.status, "success");
  assert.equal(result.employees, 500);
  assert.equal(result.revenue_band, "$50M-$100M");
  assert.deepEqual(result.tech_stack, ["Salesforce"]);
  assert.equal(result.last_updated, "2026-07-01T09:00:00.000Z");
  assert.equal(result.confidence, "High");
  assert.equal(result.source_name, "Clearbit");
});

test("enrich_profile returns no_result for empty validated fixture", async () => {
  const result = await enrichProfile("lean-tech.co", {
    evaluatedAt,
    fixtures,
  });
  assert.equal(result.status, "no_result");
  assert.equal(result.message, "No matching records found.");
  assert.equal(result.employees, undefined);
  assert.equal(result.tech_stack.length, 0);
});

test("enrich_profile returns invalid_result for malformed fixture", async () => {
  const result = await enrichProfile("bad-enrich.co", {
    evaluatedAt,
    fixtures,
  });
  assert.equal(result.status, "invalid_result");
  assert.match(result.message ?? "", /Malformed enrichment fixture/i);
});

test("fetch_intent_triggers keeps intent and engagement distinct", async () => {
  const result = await fetchIntentTriggers("john.smith@enterprisecorp.com", {
    evaluatedAt,
    fixtures,
  });
  assert.equal(result.status, "success");
  assert.equal(result.surge, true);
  assert.equal(result.demo_request, true);
  assert.equal(result.pricing_page_visit, true);
  assert.equal(result.opens, 2);
  assert.equal(result.clicks, 1);
  assert.equal(result.replies, 1);
  assert.equal(result.intent_source_name, "IntentStream");
  assert.equal(result.engagement_source_name, "HubSpot");
  assert.equal(result.source_name, "Mixed Signals");
  assert.equal(result.last_updated, "2026-07-08T09:00:00.000Z");
});

test("fetch_intent_triggers returns no_result for empty engagement/intent activity", async () => {
  const result = await fetchIntentTriggers("quiet@enterprisecorp.com", {
    evaluatedAt,
    fixtures,
  });
  assert.equal(result.status, "no_result");
  assert.equal(result.opens, 0);
  assert.equal(result.clicks, 0);
  assert.equal(result.replies, 0);
  assert.equal(result.demo_request, false);
  assert.equal(result.pricing_page_visit, false);
  assert.equal(result.surge, false);
});

test("fetch_intent_triggers returns invalid_result for malformed fixture", async () => {
  const result = await fetchIntentTriggers("bad-intent@enterprisecorp.com", {
    evaluatedAt,
    fixtures,
  });
  assert.equal(result.status, "invalid_result");
  assert.match(result.message ?? "", /Malformed intent fixture/i);
});

test("fetch_public_signals returns validated signal fixture and allows record-id provenance", async () => {
  const result = await fetchPublicSignals("EnterpriseCorp", {
    evaluatedAt,
    fixtures,
  });
  assert.equal(result.status, "success");
  assert.equal(result.signals.length, 1);
  assert.equal(result.signals[0].label, "Series B funding announced");
  assert.equal(result.signals[0].source_record_id, "cb-enterprisecorp-b");
});

test("fetch_public_signals returns no_result for empty signal fixture", async () => {
  const result = await fetchPublicSignals("EmptySignals", {
    evaluatedAt,
    fixtures,
  });
  assert.equal(result.status, "no_result");
  assert.equal(result.signals.length, 0);
});

test("fetch_public_signals returns invalid_result for malformed fixture", async () => {
  const result = await fetchPublicSignals("BadSignals", {
    evaluatedAt,
    fixtures,
  });
  assert.equal(result.status, "invalid_result");
  assert.match(result.message ?? "", /Malformed public signal fixture/i);
});

test("fetch_public_signals keeps valid entries and drops malformed entries in partial-failure payloads", async () => {
  const result = await fetchPublicSignals("PartialSignals", {
    evaluatedAt,
    fixtures,
  });
  assert.equal(result.status, "success");
  assert.equal(result.signals.length, 1);
  assert.equal(result.signals[0].label, "Series A announced");
  assert.equal(result.signals[0].source_record_id, "cb-partial-a");
  assert.equal(result.evidence.length, 1);
});

test("fetch_public_signals preserves stale source timestamps for downstream freshness semantics", async () => {
  const result = await fetchPublicSignals("staleSignal", {
    evaluatedAt,
    fixtures,
  });
  assert.equal(result.status, "success");
  assert.equal(result.signals.length, 1);
  assert.equal(result.signals[0].published_at, "2025-01-01T09:00:00.000Z");
  assert.equal(result.evidence[0].source_published_at, "2025-01-01T09:00:00.000Z");
});

test("live provider payload validation maps malformed responses to invalid_result", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        tech_stack: "not-an-array",
      }),
      { status: 200 }
    );

  try {
    const bad = await enrichProfile("anycorp.com", {
      evaluatedAt,
      env: { ENRICHMENT_API_URL: "https://enrich.example/v1/profile" },
    });
    assert.equal(bad.status, "invalid_result");

    const malformed = await fetchPublicSignals("AnyCo", {
      evaluatedAt,
      env: { PUBLIC_SIGNALS_API_URL: "https://signals.example/v1/company" },
    });
    assert.equal(malformed.status, "invalid_result");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("adapter evidence matches the shared scalar and field-map contract", async () => {
  const enrichment = await enrichProfile("enterprisecorp.com", { evaluatedAt, fixtures });
  assert.equal(enrichment.status, "success");
  assert.deepEqual(enrichment.evidence[0].field_values, { employees: 500 });

  const activity = await fetchIntentTriggers("john.smith@enterprisecorp.com", { evaluatedAt, fixtures });
  assert.equal(activity.status, "success");
  const engagement = activity.evidence.find((item) => item.source_type === "engagement");
  assert.equal(engagement?.field_value, "engagement activity");
  assert.deepEqual(engagement?.field_values, {
    opens: 2,
    clicks: 1,
    replies: 1,
    demo_request: true,
    pricing_page_visit: true,
  });
});

test("enrichment rejects invalid confidence, freshness, URLs, and technology entries", async () => {
  const originalFetch = globalThis.fetch;
  const invalidPayloads = [
    { source_name: "Provider", employees: 10, last_updated: evaluatedAt, confidence: "Certain" },
    { source_name: "Provider", employees: 10, confidence: "High" },
    { source_name: "Provider", employees: 10, last_updated: evaluatedAt, source_url: "ftp://example.com/profile" },
    { source_name: "Provider", employees: 10, last_updated: evaluatedAt, tech_stack: ["Astro", 42] },
  ];
  try {
    for (const payload of invalidPayloads) {
      globalThis.fetch = async () => new Response(JSON.stringify(payload), { status: 200 });
      const result = await enrichProfile("example.com", {
        evaluatedAt,
        env: { ENRICHMENT_API_URL: "https://enrich.example/v1/profile" },
      });
      assert.equal(result.status, "invalid_result");
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("public evidence IDs include provider record identity", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ signals: [
    { label: "Funding announced", source: "Provider", source_record_id: "record-1", published_at: evaluatedAt },
    { label: "Funding announced", source: "Provider", source_record_id: "record-2", published_at: evaluatedAt },
  ] }), { status: 200 });
  try {
    const result = await fetchPublicSignals("Example", {
      evaluatedAt,
      env: { PUBLIC_SIGNALS_API_URL: "https://signals.example/v1/company" },
    });
    assert.equal(result.status, "success");
    assert.equal(new Set(result.evidence.map((item) => item.evidence_id)).size, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("live provider timeouts retry a bounded number of times then return timeout", async () => {
  const originalFetch = globalThis.fetch;
  let attempts = 0;
  globalThis.fetch = async () => {
    attempts += 1;
    const error = new Error("The operation was aborted due to timeout");
    error.name = "TimeoutError";
    throw error;
  };

  try {
    const result = await fetchPublicSignals("AnyCo", {
      evaluatedAt,
      env: { PUBLIC_SIGNALS_API_URL: "https://signals.example/v1/company" },
      maxRetries: 1,
      timeoutMs: 50,
    });
    assert.equal(result.status, "timeout");
    assert.equal(attempts, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("live provider timeout can recover with bounded retries", async () => {
  const originalFetch = globalThis.fetch;
  let attempts = 0;
  globalThis.fetch = async () => {
    attempts += 1;
    if (attempts < 2) {
      const error = new Error("The operation was aborted due to timeout");
      error.name = "TimeoutError";
      throw error;
    }
    return new Response(
      JSON.stringify({
        signals: [
          {
            label: "Recovered signal",
            source: "Crunchbase",
            source_record_id: "cb-recovered",
            published_at: "2026-07-01T09:00:00.000Z",
          },
        ],
      }),
      { status: 200 }
    );
  };

  try {
    const result = await fetchPublicSignals("AnyCo", {
      evaluatedAt,
      env: { PUBLIC_SIGNALS_API_URL: "https://signals.example/v1/company" },
      maxRetries: 2,
      timeoutMs: 50,
    });
    assert.equal(result.status, "success");
    assert.equal(attempts, 2);
    assert.equal(result.signals.length, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("live provider errors map to exact terminal statuses", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    return new Response("rate limited", { status: 429 });
  };

  try {
    const throttled = await fetchIntentTriggers("john.smith@enterprisecorp.com", {
      evaluatedAt,
      env: { INTENT_API_URL: "https://signals.example/v1/intent" },
      timeoutMs: 200,
    });
    assert.equal(throttled.status, "rate_limited");

    globalThis.fetch = async () => {
      const error = new Error("The operation was aborted due to timeout");
      error.name = "TimeoutError";
      throw error;
    };

    const timeout = await enrichProfile("anycorp.com", {
      evaluatedAt,
      env: { ENRICHMENT_API_URL: "https://enrich.example/v1/profile" },
      timeoutMs: 200,
    });
    assert.equal(timeout.status, "timeout");
    assert.equal(timeout.message, "Data unavailable");
    assert.equal(timeout.employees, undefined);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("write_crm_enrichment is read-only and never writes", async () => {
  const originalFetch = globalThis.fetch;
  let called = false;
  globalThis.fetch = async () => {
    called = true;
    return new Response("{}", { status: 500 });
  };
  try {
    const result = await writeCrmEnrichment("golden-normal", { numberofemployees: "500" });
    assert.equal(result.status, "skipped");
    assert.equal(result.writable, false);
    assert.match(result.reason, /read-only placeholder/i);
    assert.equal(called, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
