import { createHmac, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";

export type ActorRole = "revops_admin" | "rep" | "system" | "integration";

export type RequestIdentity = Readonly<{
  requestId: string;
  tenantId: string;
  actorId: string;
  role: ActorRole;
}>;

export const isLoopbackAddress = (address?: string) => {
  if (!address) return false;
  if (isIP(address) === 4) return address.startsWith("127.");
  return isIP(address) === 6 && (address === "::1" || address.toLowerCase().startsWith("::ffff:127."));
};

export const adminOriginsFromEnv = (configured?: string) => new Set(
  configured ? [configured] : ["http://127.0.0.1:4321", "http://localhost:4321"]
);

const controlText = /[\u0000-\u001f\u007f]/;
const actorRoles: readonly string[] = ["revops_admin", "rep", "system", "integration"];

export const assertRequestIdentity = (identity: RequestIdentity) => {
  const required = ["requestId", "tenantId", "actorId", "role"];
  if (!identity || Object.keys(identity).length !== required.length || required.some((name) => !(name in identity))) {
    throw new Error("request identity is invalid");
  }
  for (const [name, value] of Object.entries(identity)) {
    if (typeof value !== "string" || !value.trim() || controlText.test(value)) throw new Error(`${name} is invalid`);
  }
  if (!actorRoles.includes(identity.role)) throw new Error("role is invalid");
};

export const assertTenantAccess = (identity: RequestIdentity, tenantId: string) => {
  assertRequestIdentity(identity);
  if (identity.tenantId !== tenantId) throw new Error("Cross-tenant access denied");
};

export const assertAdminAccess = (identity: RequestIdentity, tenantId = identity.tenantId) => {
  assertTenantAccess(identity, tenantId);
  if (identity.role !== "revops_admin") throw new Error("RevOps Admin access required");
};

export const canReadAssignedEvaluation = (identity: RequestIdentity, assignedRepId: string | null) =>
  identity.role !== "rep" || assignedRepId === identity.actorId;

export const sessionSecretFromEnv = (value = process.env.SESSION_SECRET) => {
  if (!value || Buffer.byteLength(value) < 32) throw new Error("SESSION_SECRET must be at least 32 bytes");
  return value;
};

const signatureFor = (payload: string, secret: string) => createHmac("sha256", secret).update(payload).digest("base64url");

export const createSessionToken = (identity: RequestIdentity, expiresAt: string, secret = sessionSecretFromEnv()) => {
  assertRequestIdentity(identity);
  const expires = Date.parse(expiresAt);
  if (!Number.isFinite(expires)) throw new Error("expiresAt is invalid");
  const payload = Buffer.from(JSON.stringify({ ...identity, expires })).toString("base64url");
  return `${payload}.${signatureFor(payload, secret)}`;
};

export const authenticateBearer = (authorization: string | undefined, secret = sessionSecretFromEnv(), now = Date.now()): RequestIdentity => {
  const token = authorization?.startsWith("Bearer ") ? authorization.slice(7) : "";
  const [payload, signature] = token.split(".");
  if (!payload || !signature) throw new Error("Authentication required");
  const expected = Buffer.from(signatureFor(payload, secret));
  const supplied = Buffer.from(signature);
  if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) throw new Error("Authentication required");
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    throw new Error("Authentication required");
  }
  if (typeof decoded !== "object" || decoded === null || Array.isArray(decoded)) throw new Error("Authentication required");
  const { expires, ...identity } = decoded as Record<string, unknown>;
  assertRequestIdentity(identity as RequestIdentity);
  if (typeof expires !== "number" || !Number.isFinite(expires) || expires <= now) throw new Error("Session expired");
  return identity as RequestIdentity;
};

const hubSpotEscapes = /%3A|%2F|%3F|%40|%21|%24|%27|%28|%29|%2A|%2C|%3B/gi;

export const verifyHubSpotRequestSignature = (input: Readonly<{
  method: string;
  uri: string;
  body: string;
  signature?: string;
  timestamp?: string;
  clientSecret: string;
  now?: number;
}>) => {
  const timestamp = Number(input.timestamp);
  if (!input.signature || !input.clientSecret || !Number.isSafeInteger(timestamp) || Math.abs((input.now ?? Date.now()) - timestamp) > 300_000) return false;
  const [base, query] = input.uri.split("?", 2);
  const uri = query === undefined ? base! : `${base}?${query.replace(hubSpotEscapes, decodeURIComponent)}`;
  const expected = createHmac("sha256", input.clientSecret)
    .update(`${input.method}${uri.split("#", 1)[0]}${input.body}${input.timestamp}`)
    .digest("base64");
  const left = Buffer.from(input.signature);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
};
