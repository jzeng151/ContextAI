import { randomUUID } from "node:crypto";
import { exchangeHubSpotAuthorizationCode, hubSpotAuthorizationUrl, hubSpotOAuthConfigFromEnv, hubSpotRequiredScopes, revokeHubSpotRefreshToken, type HubSpotOAuthConfig, type HubSpotOAuthTokens } from "./integrations.ts";
import type { RuntimeStore } from "./persistence.ts";
import { assertAdminAccess, bootstrapTokenFromEnv, createOAuthState, createSessionToken, hashOAuthState, sessionSecretFromEnv, verifyBootstrapToken, type RequestIdentity } from "./security.ts";
import { secretKeyFromEnv } from "./secrets.ts";

type Env = Record<string, string | undefined>;

export class OnboardingError extends Error {
  readonly status: number;
  readonly publicMessage: string;

  constructor(status: number, publicMessage: string) {
    super(publicMessage);
    this.status = status;
    this.publicMessage = publicMessage;
  }
}

const required = (env: Env, name: string) => {
  const value = env[name];
  if (!value) throw new Error(`Missing ${name}`);
  return value;
};

const baseUrl = (value: string, name: string) => {
  const url = new URL(value);
  if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error(`${name} is invalid`);
  return value.replace(/\/+$/, "");
};

const oauthRuntimeConfigFromEnv = (env: Env) => {
  try {
    const tenantId = env.CONTEXTAI_TENANT_ID ?? "local";
    const integrationId = required(env, "HUBSPOT_INTEGRATION_ID");
    const apiUrl = baseUrl(required(env, "CONTEXTAI_API_URL"), "CONTEXTAI_API_URL");
    const appUrl = baseUrl(required(env, "CONTEXTAI_APP_URL"), "CONTEXTAI_APP_URL");
    const oauth = hubSpotOAuthConfigFromEnv(env);
    if (oauth.redirectUri !== `${apiUrl}/oauth/hubspot/callback`) throw new Error("HUBSPOT_REDIRECT_URI does not match CONTEXTAI_API_URL");
    return { tenantId, integrationId, appUrl, oauth, key: secretKeyFromEnv(env.INTEGRATION_SECRET_KEY) };
  } catch {
    throw new OnboardingError(503, "HubSpot OAuth is unavailable");
  }
};

export const createAdminSession = (
  bootstrapToken: unknown,
  env: Env = process.env,
  now = Date.now(),
  requestId = randomUUID(),
) => {
  let configured: string;
  let secret: string;
  let tenantId: string;
  try {
    configured = bootstrapTokenFromEnv(env.CONTEXTAI_ADMIN_BOOTSTRAP_TOKEN);
    secret = sessionSecretFromEnv(env.SESSION_SECRET);
    if (verifyBootstrapToken(configured, secret)) throw new Error("Authentication secrets must be distinct");
    tenantId = env.CONTEXTAI_TENANT_ID ?? "local";
  } catch {
    throw new OnboardingError(503, "Authentication is unavailable");
  }
  if (typeof bootstrapToken !== "string" || !verifyBootstrapToken(bootstrapToken, configured)) {
    throw new OnboardingError(401, "Authentication failed");
  }
  const expiresAt = new Date(now + 8 * 60 * 60 * 1000).toISOString();
  const identity = { requestId, tenantId, actorId: "demo-admin", role: "revops_admin" } as const;
  return { token: createSessionToken(identity, expiresAt, secret), expiresAt };
};

export const startHubSpotOAuth = (
  identity: RequestIdentity,
  store: RuntimeStore,
  env: Env = process.env,
  now = Date.now(),
  state = createOAuthState(),
) => {
  const config = oauthRuntimeConfigFromEnv(env);
  assertAdminAccess(identity, config.tenantId);
  store.saveTenant(config.tenantId, "ContextAI demo");
  const createdAt = new Date(now).toISOString();
  store.saveOAuthState(identity, config.integrationId, hashOAuthState(state), new Date(now + 10 * 60 * 1000).toISOString(), createdAt);
  return { authorizationUrl: hubSpotAuthorizationUrl(config.oauth, state) };
};

type CallbackInput = Readonly<{ code?: string | null; state?: string | null; error?: string | null }>;

export const completeHubSpotOAuth = async (
  input: CallbackInput,
  store: RuntimeStore,
  env: Env = process.env,
  now = Date.now(),
  exchange: (code: string, config: HubSpotOAuthConfig) => Promise<HubSpotOAuthTokens> = exchangeHubSpotAuthorizationCode,
  requestId = randomUUID(),
  revoke: (refreshToken: string, config: HubSpotOAuthConfig) => Promise<void> = revokeHubSpotRefreshToken,
) => {
  const config = oauthRuntimeConfigFromEnv(env);
  if (!input.state) throw new OnboardingError(400, "HubSpot connection could not be completed");
  const state = store.consumeOAuthState(requestId, config.tenantId, config.integrationId, hashOAuthState(input.state), new Date(now).toISOString());
  if (!state) throw new OnboardingError(400, "HubSpot connection could not be completed");
  if (input.error || !input.code) throw new OnboardingError(400, "HubSpot connection could not be completed");

  let tokens: HubSpotOAuthTokens;
  try {
    tokens = await exchange(input.code, config.oauth);
  } catch {
    throw new OnboardingError(502, "HubSpot connection could not be completed");
  }
  if (!tokens.access_token || !tokens.refresh_token || !Number.isSafeInteger(tokens.expires_in) || tokens.expires_in <= 0 ||
    !Number.isSafeInteger(tokens.hub_id) || tokens.hub_id! <= 0 || !Array.isArray(tokens.scopes) || hubSpotRequiredScopes.some((scope) => !tokens.scopes!.includes(scope))) {
    throw new OnboardingError(400, "HubSpot connection could not be completed");
  }

  const identity = { requestId, tenantId: config.tenantId, actorId: state.actorId, role: "revops_admin" } as const;
  const portalId = String(tokens.hub_id);
  if (store.ensureHubSpotIntegration(identity, config.integrationId, portalId) === "conflict") {
    try {
      await revoke(tokens.refresh_token, config.oauth);
    } catch {
      throw new OnboardingError(502, "HubSpot connection could not be completed");
    }
    throw new OnboardingError(409, "HubSpot account does not match this integration");
  }
  store.activateHubSpotIntegration(identity, config.integrationId, {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    scopes: tokens.scopes,
    expiresAt: new Date(now + tokens.expires_in * 1000).toISOString(),
    externalAccountId: portalId,
  }, config.key);
  return `${config.appUrl}/admin?hubspot=connected`;
};
