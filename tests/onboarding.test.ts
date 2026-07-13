import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import { hubSpotRequiredScopes, type HubSpotOAuthTokens } from "../src/lib/integrations.ts";
import { safeReturnTo } from "../src/lib/login.ts";
import { completeHubSpotOAuth, createAdminSession, OnboardingError, startHubSpotOAuth } from "../src/lib/onboarding.ts";
import { RuntimeStore } from "../src/lib/persistence.ts";
import { authenticateBearer, createOAuthState, createSessionToken, hashOAuthState, type RequestIdentity } from "../src/lib/security.ts";
import { decryptSecret } from "../src/lib/secrets.ts";

const now = Date.parse("2026-07-12T12:00:00.000Z");
const key = Buffer.alloc(32, 7);
const env = {
  CONTEXTAI_ADMIN_BOOTSTRAP_TOKEN: "bootstrap-token-that-is-at-least-thirty-two-bytes",
  SESSION_SECRET: "session-secret-that-is-at-least-thirty-two-bytes",
  CONTEXTAI_TENANT_ID: "tenant-1",
  CONTEXTAI_API_URL: "https://api.contextai.example",
  CONTEXTAI_APP_URL: "https://app.contextai.example",
  HUBSPOT_CLIENT_ID: "hubspot-client",
  HUBSPOT_CLIENT_SECRET: "hubspot-secret",
  HUBSPOT_REDIRECT_URI: "https://api.contextai.example/oauth/hubspot/callback",
  HUBSPOT_INTEGRATION_ID: "hubspot-demo",
  INTEGRATION_SECRET_KEY: key.toString("base64"),
} as const;
const admin: RequestIdentity = { requestId: "oauth-start", tenantId: "tenant-1", actorId: "demo-admin", role: "revops_admin" };
const tokens = (overrides: Partial<HubSpotOAuthTokens> = {}): HubSpotOAuthTokens => ({
  access_token: "access-token",
  refresh_token: "refresh-token",
  expires_in: 1800,
  hub_id: 123,
  scopes: [...hubSpotRequiredScopes],
  ...overrides,
});
const storeFor = () => {
  const store = new RuntimeStore(":memory:");
  store.saveTenant(admin.tenantId, "OAuth test tenant");
  return store;
};

test("admin session creation validates bootstrap configuration, identity, and eight-hour expiry", () => {
  const session = createAdminSession(env.CONTEXTAI_ADMIN_BOOTSTRAP_TOKEN, env, now, "session-request");
  assert.equal(session.expiresAt, "2026-07-12T20:00:00.000Z");
  assert.deepEqual(authenticateBearer(`Bearer ${session.token}`, env.SESSION_SECRET, now), {
    requestId: "session-request", tenantId: env.CONTEXTAI_TENANT_ID, actorId: "demo-admin", role: "revops_admin"
  });
  assert.throws(() => authenticateBearer(`Bearer ${session.token}`, env.SESSION_SECRET, Date.parse(session.expiresAt)), /expired/i);
  assert.throws(() => createAdminSession("wrong-token", env, now), (error) => error instanceof OnboardingError && error.status === 401 && error.publicMessage === "Authentication failed");
  assert.throws(() => createAdminSession(env.CONTEXTAI_ADMIN_BOOTSTRAP_TOKEN, { ...env, CONTEXTAI_ADMIN_BOOTSTRAP_TOKEN: undefined }, now), (error) => error instanceof OnboardingError && error.status === 503);
  assert.throws(() => createAdminSession("short", { ...env, CONTEXTAI_ADMIN_BOOTSTRAP_TOKEN: "short" }, now), (error) => error instanceof OnboardingError && error.status === 503);
  assert.throws(() => createAdminSession(env.CONTEXTAI_ADMIN_BOOTSTRAP_TOKEN, { ...env, SESSION_SECRET: undefined }, now), (error) => error instanceof OnboardingError && error.status === 503);
  assert.throws(() => createAdminSession(env.CONTEXTAI_ADMIN_BOOTSTRAP_TOKEN, { ...env, SESSION_SECRET: env.CONTEXTAI_ADMIN_BOOTSTRAP_TOKEN }, now), (error) => error instanceof OnboardingError && error.status === 503 && error.publicMessage === "Authentication is unavailable");
});

test("OAuth state is random, hashed at rest, tenant-bound, expiring, purgeable, and single-use", () => {
  const store = storeFor();
  try {
    store.saveTenant("tenant-2", "Other tenant");
    const first = createOAuthState();
    const second = createOAuthState();
    assert.notEqual(first, second);
    assert.equal(first.length, 43);
    const hash = hashOAuthState(first);
    store.saveOAuthState(admin, env.HUBSPOT_INTEGRATION_ID, hash, "2026-07-12T12:10:00.000Z", "2026-07-12T12:00:00.000Z");
    const stored = store.database.prepare("SELECT * FROM oauth_state_records WHERE state_hash = ?").get(hash) as Record<string, unknown>;
    assert.equal(stored.state_hash, hash);
    assert.doesNotMatch(JSON.stringify(stored), new RegExp(first));
    assert.equal(store.consumeOAuthState("wrong-tenant", "tenant-2", env.HUBSPOT_INTEGRATION_ID, hash, "2026-07-12T12:01:00.000Z"), null);
    assert.deepEqual(store.consumeOAuthState("consume-state", admin.tenantId, env.HUBSPOT_INTEGRATION_ID, hash, "2026-07-12T12:01:00.000Z"), { actorId: admin.actorId });
    assert.equal(store.consumeOAuthState("replay-state", admin.tenantId, env.HUBSPOT_INTEGRATION_ID, hash, "2026-07-12T12:02:00.000Z"), null);

    const expiredHash = hashOAuthState("expired-state");
    store.saveOAuthState(admin, env.HUBSPOT_INTEGRATION_ID, expiredHash, "2026-07-12T12:01:00.000Z", "2026-07-12T12:00:00.000Z");
    assert.equal(store.consumeOAuthState("expired-state", admin.tenantId, env.HUBSPOT_INTEGRATION_ID, expiredHash, "2026-07-12T12:01:00.000Z"), null);
    const audits = (store.database.prepare("SELECT count(*) AS count FROM access_audit_records").get() as { count: number }).count;
    assert.equal(store.purgeExpiredOAuthStates("2026-07-12T12:01:00.000Z"), 1);
    assert.equal((store.database.prepare("SELECT count(*) AS count FROM access_audit_records").get() as { count: number }).count, audits);
  } finally {
    store.close();
  }
});

test("OAuth start requires a tenant admin and complete runtime configuration", () => {
  const store = storeFor();
  try {
    const rep = { ...admin, role: "rep" as const, actorId: "rep-1" };
    assert.throws(() => startHubSpotOAuth(rep, store, env, now, "rep-state"), /RevOps Admin/i);
    for (const broken of [
      { ...env, CONTEXTAI_API_URL: undefined },
      { ...env, CONTEXTAI_APP_URL: undefined },
      { ...env, HUBSPOT_CLIENT_ID: undefined },
      { ...env, HUBSPOT_CLIENT_SECRET: undefined },
      { ...env, HUBSPOT_INTEGRATION_ID: undefined },
      { ...env, HUBSPOT_REDIRECT_URI: "https://wrong.example/callback" },
      { ...env, INTEGRATION_SECRET_KEY: undefined },
    ]) {
      assert.throws(() => startHubSpotOAuth(admin, store, broken, now, createOAuthState()), (error) => error instanceof OnboardingError && error.status === 503);
    }
    const first = startHubSpotOAuth(admin, store, env, now);
    const second = startHubSpotOAuth(admin, store, env, now + 1);
    const firstUrl = new URL(first.authorizationUrl);
    const secondUrl = new URL(second.authorizationUrl);
    assert.equal(firstUrl.origin, "https://app.hubspot.com");
    assert.notEqual(firstUrl.searchParams.get("state"), secondUrl.searchParams.get("state"));
    assert.equal(firstUrl.searchParams.get("redirect_uri"), env.HUBSPOT_REDIRECT_URI);
  } finally {
    store.close();
  }
});

test("OAuth start initializes the configured tenant in a fresh database", () => {
  const store = new RuntimeStore(":memory:");
  try {
    const result = startHubSpotOAuth(admin, store, env, now, "fresh-database-state");
    assert.equal(new URL(result.authorizationUrl).searchParams.get("state"), "fresh-database-state");
    assert.deepEqual(
      { ...(store.database.prepare("SELECT tenant_id, name FROM tenants").get() as Record<string, string>) },
      { tenant_id: admin.tenantId, name: "ContextAI demo" }
    );
    assert.equal((store.database.prepare("SELECT count(*) AS count FROM oauth_state_records").get() as { count: number }).count, 1);
  } finally {
    store.close();
  }
});

test("successful HubSpot callback activates the expected portal with encrypted credentials", async () => {
  const store = storeFor();
  const state = "successful-oauth-state";
  try {
    startHubSpotOAuth(admin, store, env, now, state);
    const redirect = await completeHubSpotOAuth({ code: "authorization-code", state }, store, env, now, async () => tokens(), "callback-request");
    assert.equal(redirect, "https://app.contextai.example/admin?hubspot=connected");
    assert.doesNotMatch(redirect, /access-token|refresh-token|authorization-code/);
    const integration = store.database.prepare(`
      SELECT status, tenant_id, provider, external_account_id, access_token_ciphertext, refresh_token_ciphertext
      FROM integrations WHERE integration_id = ?
    `).get(env.HUBSPOT_INTEGRATION_ID) as Record<string, string>;
    assert.deepEqual({ status: integration.status, tenant: integration.tenant_id, provider: integration.provider, portal: integration.external_account_id }, {
      status: "active", tenant: admin.tenantId, provider: "hubspot", portal: "123"
    });
    assert.doesNotMatch(JSON.stringify(integration), /access-token|refresh-token/);
    assert.equal(decryptSecret(integration.access_token_ciphertext, key), "access-token");
    assert.equal(decryptSecret(integration.refresh_token_ciphertext, key), "refresh-token");
    assert.deepEqual(
      (store.database.prepare("SELECT action, outcome FROM access_audit_records WHERE request_id = ? ORDER BY access_audit_id").all("callback-request") as Array<Record<string, string>>).map((row) => ({ ...row })),
      [
        { action: "oauth.state.consume", outcome: "allowed" },
        { action: "integration.create", outcome: "allowed" },
        { action: "integration.connect", outcome: "allowed" },
      ]
    );
  } finally {
    store.close();
  }
});

test("HubSpot callback safely rejects provider errors, bad or expired state, replay, scopes, portal mismatch, and exchange failure", async (t) => {
  await t.test("provider error consumes its state", async () => {
    const store = storeFor();
    try {
      startHubSpotOAuth(admin, store, env, now, "provider-error-state");
      await assert.rejects(completeHubSpotOAuth({ error: "access_denied", state: "provider-error-state" }, store, env, now), (error) => error instanceof OnboardingError && error.status === 400 && !error.message.includes("access_denied"));
      await assert.rejects(completeHubSpotOAuth({ code: "code", state: "provider-error-state" }, store, env, now, async () => tokens()), (error) => error instanceof OnboardingError && error.status === 400);
    } finally { store.close(); }
  });

  await t.test("bad and expired states", async () => {
    const store = storeFor();
    try {
      await assert.rejects(completeHubSpotOAuth({ code: "code", state: "unknown" }, store, env, now, async () => tokens()), (error) => error instanceof OnboardingError && error.status === 400);
      startHubSpotOAuth(admin, store, env, now, "expired");
      await assert.rejects(completeHubSpotOAuth({ code: "code", state: "expired" }, store, env, now + 600_000), (error) => error instanceof OnboardingError && error.status === 400);
    } finally { store.close(); }
  });

  await t.test("replay", async () => {
    const store = storeFor();
    try {
      startHubSpotOAuth(admin, store, env, now, "single-use");
      await completeHubSpotOAuth({ code: "code", state: "single-use" }, store, env, now, async () => tokens());
      await assert.rejects(completeHubSpotOAuth({ code: "code", state: "single-use" }, store, env, now, async () => tokens()), (error) => error instanceof OnboardingError && error.status === 400);
    } finally { store.close(); }
  });

  await t.test("insufficient scopes", async () => {
    const store = storeFor();
    try {
      startHubSpotOAuth(admin, store, env, now, "scope-state");
      await assert.rejects(completeHubSpotOAuth({ code: "code", state: "scope-state" }, store, env, now, async () => tokens({ scopes: ["oauth"] })), (error) => error instanceof OnboardingError && error.status === 400);
      startHubSpotOAuth(admin, store, env, now, "invalid-portal-state");
      await assert.rejects(completeHubSpotOAuth({ code: "code", state: "invalid-portal-state" }, store, env, now, async () => tokens({ hub_id: 0 })), (error) => error instanceof OnboardingError && error.status === 400);
      assert.equal(store.database.prepare("SELECT 1 FROM integrations").get(), undefined);
    } finally { store.close(); }
  });

  await t.test("portal mismatch", async () => {
    const store = storeFor();
    try {
      store.saveIntegration(admin, { integrationId: env.HUBSPOT_INTEGRATION_ID, provider: "hubspot", externalAccountId: "999", status: "disabled" });
      startHubSpotOAuth(admin, store, env, now, "portal-state");
      let revoked = "";
      await assert.rejects(completeHubSpotOAuth({ code: "code", state: "portal-state" }, store, env, now, async () => tokens(), "portal-callback", async (token) => { revoked = token; }), (error) => error instanceof OnboardingError && error.status === 409);
      assert.equal(revoked, "refresh-token");
      assert.equal((store.database.prepare("SELECT status FROM integrations WHERE integration_id = ?").get(env.HUBSPOT_INTEGRATION_ID) as { status: string }).status, "disabled");
    } finally { store.close(); }

    const duplicate = storeFor();
    try {
      duplicate.saveIntegration(admin, { integrationId: "other-hubspot", provider: "hubspot", externalAccountId: "123", status: "disabled" });
      startHubSpotOAuth(admin, duplicate, env, now, "duplicate-portal-state");
      let revoked = "";
      await assert.rejects(completeHubSpotOAuth({ code: "code", state: "duplicate-portal-state" }, duplicate, env, now, async () => tokens(), "duplicate-callback", async (token) => { revoked = token; }), (error) => error instanceof OnboardingError && error.status === 409);
      assert.equal(revoked, "refresh-token");
    } finally { duplicate.close(); }

    const failedRevocation = storeFor();
    try {
      failedRevocation.saveIntegration(admin, { integrationId: env.HUBSPOT_INTEGRATION_ID, provider: "hubspot", externalAccountId: "999", status: "disabled" });
      startHubSpotOAuth(admin, failedRevocation, env, now, "failed-revocation-state");
      await assert.rejects(
        completeHubSpotOAuth({ code: "code", state: "failed-revocation-state" }, failedRevocation, env, now, async () => tokens(), "failed-revocation", async () => { throw new Error("provider payload"); }),
        (error) => error instanceof OnboardingError && error.status === 502 && !error.message.includes("provider")
      );
      const integration = failedRevocation.database.prepare("SELECT status, access_token_ciphertext, refresh_token_ciphertext FROM integrations WHERE integration_id = ?").get(env.HUBSPOT_INTEGRATION_ID) as Record<string, unknown>;
      assert.deepEqual({ ...integration }, { status: "disabled", access_token_ciphertext: null, refresh_token_ciphertext: null });
    } finally { failedRevocation.close(); }
  });

  await t.test("token exchange failure", async () => {
    const store = storeFor();
    try {
      startHubSpotOAuth(admin, store, env, now, "exchange-state");
      await assert.rejects(completeHubSpotOAuth({ code: "secret-code", state: "exchange-state" }, store, env, now, async () => { throw new Error("provider payload"); }), (error) => error instanceof OnboardingError && error.status === 502 && !error.message.includes("provider"));
      assert.equal(store.database.prepare("SELECT 1 FROM integrations").get(), undefined);
    } finally { store.close(); }
  });
});

test("login return paths stay on the current origin", () => {
  const origin = "https://app.contextai.example";
  assert.equal(safeReturnTo("/admin?hubspot=connected#integrations", origin), "/admin?hubspot=connected#integrations");
  assert.equal(safeReturnTo(`${origin}/admin`, origin), "/admin");
  for (const value of ["https://evil.example/admin", "//evil.example/admin", "javascript:alert(1)", "\\\\evil.example/admin", "https://app.contextai.example:444/admin"]) {
    assert.equal(safeReturnTo(value, origin), "/");
  }
});

test("HTTP auth and OAuth routes enforce bearer access, no-store responses, and safe callback errors", async () => {
  const directory = mkdtempSync(join(tmpdir(), "contextai-onboarding-"));
  const databasePath = join(directory, "runtime.sqlite");
  const seed = new RuntimeStore(databasePath);
  seed.close();
  const originalEnv = Object.fromEntries(Object.keys(env).concat("DATABASE_PATH").map((name) => [name, process.env[name]]));
  const originalFetch = globalThis.fetch;
  Object.assign(process.env, env, { DATABASE_PATH: databasePath });
  delete process.env.CONTEXTAI_TENANT_ID;
  const { closeRuntimeStore, handleRequest } = await import(`../src/server.ts?onboarding=${Date.now()}`);
  const request = async (method: string, url: string, input?: Readonly<{ body?: string; authorization?: string }>) => {
    const incoming = Readable.from(input?.body ? [Buffer.from(input.body)] : []) as any;
    incoming.method = method;
    incoming.url = url;
    incoming.headers = { host: "api.contextai.example", ...(input?.authorization ? { authorization: input.authorization } : {}) };
    incoming.socket = { localAddress: "127.0.0.1", remoteAddress: "127.0.0.1" };
    const headers = new Map<string, string>();
    let status = 200;
    let responseBody = "";
    const response = {
      setHeader(name: string, value: unknown) { headers.set(name.toLowerCase(), String(value)); return this; },
      writeHead(nextStatus: number, values: Record<string, unknown> = {}) { status = nextStatus; for (const [name, value] of Object.entries(values)) this.setHeader(name, value); return this; },
      end(value: unknown = "") { responseBody += value == null ? "" : String(value); return this; },
    } as any;
    await handleRequest(incoming, response);
    return { status, headers, body: responseBody };
  };
  try {
    const invalid = await request("POST", "/auth/session", { body: JSON.stringify({ bootstrapToken: "wrong" }) });
    assert.equal(invalid.status, 401);
    assert.equal(invalid.headers.get("cache-control"), "no-store");
    assert.deepEqual(JSON.parse(invalid.body), { error: "Authentication failed" });

    const unauthenticatedStart = await request("POST", "/oauth/hubspot/start");
    assert.equal(unauthenticatedStart.status, 401);
    assert.equal(unauthenticatedStart.headers.get("cache-control"), "no-store");

    const sessionResponse = await request("POST", "/auth/session", { body: JSON.stringify({ bootstrapToken: env.CONTEXTAI_ADMIN_BOOTSTRAP_TOKEN }) });
    assert.equal(sessionResponse.status, 200);
    assert.equal(sessionResponse.headers.get("cache-control"), "no-store");
    const session = JSON.parse(sessionResponse.body) as { token: string };
    const freshAdmin = await request("GET", "/admin/integrations", { authorization: `Bearer ${session.token}` });
    assert.equal(freshAdmin.status, 200);
    assert.deepEqual(JSON.parse(freshAdmin.body), { integrations: [] });

    const browserMorningRun = await request("POST", "/internal/morning-run", { authorization: `Bearer ${session.token}`, body: JSON.stringify({ ownerId: "owner-1" }) });
    assert.equal(browserMorningRun.status, 403);
    assert.deepEqual(JSON.parse(browserMorningRun.body), { error: "Morning-run access denied" });
    const runnerToken = createSessionToken(
      { requestId: "morning-run", tenantId: "local", actorId: "scheduler", role: "system" },
      new Date(Date.now() + 60_000).toISOString(),
      env.SESSION_SECRET,
    );
    const runnerMissingOwner = await request("POST", "/internal/morning-run", { authorization: `Bearer ${runnerToken}`, body: "{}" });
    assert.equal(runnerMissingOwner.status, 400);
    assert.deepEqual(JSON.parse(runnerMissingOwner.body), { error: "ownerId is required" });

    const beginOAuth = async () => {
      const response = await request("POST", "/oauth/hubspot/start", { authorization: `Bearer ${session.token}` });
      assert.equal(response.status, 200);
      return new URL((JSON.parse(response.body) as { authorizationUrl: string }).authorizationUrl);
    };
    const authorization = await beginOAuth();
    const state = authorization.searchParams.get("state");
    assert.ok(state);

    const callback = await request("GET", `/oauth/hubspot/callback?error=access_denied&error_description=provider-payload&code=secret-code&state=${encodeURIComponent(state)}`);
    assert.equal(callback.status, 400);
    assert.equal(callback.headers.get("cache-control"), "no-store");
    const errorPage = callback.body;
    for (const secret of ["access_denied", "provider-payload", "secret-code", state]) assert.doesNotMatch(errorPage, new RegExp(secret));
    assert.doesNotMatch(errorPage, /stack|OnboardingError|HubSpot OAuth is unavailable/);

    const replay = await request("GET", `/oauth/hubspot/callback?code=secret-code&state=${encodeURIComponent(state)}`);
    assert.equal(replay.status, 400);
    assert.doesNotMatch(replay.body, /secret-code/);

    const hubSpotFetch = (hubId: number) => async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/introspect")) return new Response(JSON.stringify({ active: true, token_use: "access_token", hub_id: hubId, scopes: [...hubSpotRequiredScopes] }), { status: 200 });
      if (url.endsWith("/revoke")) return new Response(null, { status: 204 });
      return new Response(JSON.stringify({ access_token: "access-token", refresh_token: "refresh-token", expires_in: 1800 }), { status: 200 });
    };
    globalThis.fetch = hubSpotFetch(123);
    const successState = (await beginOAuth()).searchParams.get("state");
    assert.ok(successState);
    const success = await request("GET", `/oauth/hubspot/callback?code=authorization-code&state=${encodeURIComponent(successState)}`);
    assert.equal(success.status, 302);
    assert.equal(success.headers.get("location"), "https://app.contextai.example/admin?hubspot=connected");
    assert.doesNotMatch(`${success.headers.get("location")}${success.body}`, /access-token|refresh-token|authorization-code/);

    globalThis.fetch = hubSpotFetch(999);
    const mismatchState = (await beginOAuth()).searchParams.get("state");
    assert.ok(mismatchState);
    const mismatch = await request("GET", `/oauth/hubspot/callback?code=portal-code&state=${encodeURIComponent(mismatchState)}`);
    assert.equal(mismatch.status, 409);
    assert.doesNotMatch(mismatch.body, /999|portal-code|access-token|refresh-token/);

    globalThis.fetch = async () => new Response("provider-payload", { status: 500 });
    const failureState = (await beginOAuth()).searchParams.get("state");
    assert.ok(failureState);
    const exchangeFailure = await request("GET", `/oauth/hubspot/callback?code=exchange-code&state=${encodeURIComponent(failureState)}`);
    assert.equal(exchangeFailure.status, 502);
    assert.doesNotMatch(exchangeFailure.body, /provider-payload|exchange-code/);

    process.env.CONTEXTAI_APP_URL = "https://user:configuration-secret@app.contextai.example/?token=configuration-secret";
    const invalidAppUrl = await request("GET", "/oauth/hubspot/callback?code=code&state=state");
    assert.equal(invalidAppUrl.status, 503);
    assert.doesNotMatch(invalidAppUrl.body, /configuration-secret/);
    process.env.CONTEXTAI_APP_URL = env.CONTEXTAI_APP_URL;
  } finally {
    globalThis.fetch = originalFetch;
    closeRuntimeStore();
    for (const [name, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    rmSync(directory, { recursive: true, force: true });
  }
});

test("server and Astro pages expose only the requested browser auth and OAuth surface", () => {
  const server = readFileSync(new URL("../src/server.ts", import.meta.url), "utf8");
  const login = readFileSync(new URL("../src/pages/login.astro", import.meta.url), "utf8");
  const adminPage = readFileSync(new URL("../src/pages/admin.astro", import.meta.url), "utf8");
  for (const route of ["/auth/session", "/oauth/hubspot/start", "/oauth/hubspot/callback"]) assert.match(server, new RegExp(route.replaceAll("/", "\\/")));
  assert.match(server, /Cache-Control", "no-store"/);
  assert.match(server, /oauthFailure/);
  assert.doesNotMatch(server, /error_description|error_uri/);
  assert.match(login, /type="password"/);
  assert.match(login, /sessionStorage\.setItem\("contextai\.session-token", result\.token\)/);
  assert.doesNotMatch(login, /localStorage|sessionStorage\.setItem\([^,]+bootstrap/i);
  assert.match(adminPage, /"\/oauth\/hubspot\/start"/);
  assert.match(adminPage, /callbackStatus === "connected"/);
  assert.match(adminPage, /callbackStatus === "error"/);
  assert.match(adminPage, /response\.status === 401/);
  assert.match(adminPage, /removeItem\("contextai\.session-token"\)/);
  assert.match(adminPage, /\/login\?returnTo=/);
});
