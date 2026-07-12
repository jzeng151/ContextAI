import assert from "node:assert/strict";
import test from "node:test";
import { authenticateBearer, createSessionToken, sessionSecretFromEnv } from "../src/lib/security.ts";
import { decryptSecret, encryptSecret } from "../src/lib/secrets.ts";

test("signed sessions authenticate request identity and reject tampering or expiry", () => {
  const secret = "a sufficiently long session secret value";
  const identity = { requestId: "request-1", tenantId: "tenant-1", actorId: "rep-1", role: "rep" } as const;
  const token = createSessionToken(identity, "2026-07-12T00:00:00.000Z", secret);
  assert.deepEqual(authenticateBearer(`Bearer ${token}`, secret, Date.parse("2026-07-11T23:00:00.000Z")), identity);
  assert.throws(() => authenticateBearer(`Bearer ${token}x`, secret, Date.parse("2026-07-11T23:00:00.000Z")), /Authentication required/);
  assert.throws(() => authenticateBearer(`Bearer ${token}`, secret, Date.parse("2026-07-12T00:00:00.000Z")), /expired/);
  assert.throws(() => sessionSecretFromEnv("short"), /32 bytes/);
});

test("integration secret encryption is authenticated", () => {
  const key = Buffer.alloc(32, 4);
  const encrypted = encryptSecret("credential", key);
  assert.equal(decryptSecret(encrypted, key), "credential");
  assert.doesNotMatch(encrypted, /credential/);
  assert.throws(() => decryptSecret(`${encrypted}x`, key));
});
