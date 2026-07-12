import assert from "node:assert/strict";
import test from "node:test";
import { adminOriginsFromEnv, authenticateBearer, createSessionToken, isLoopbackAddress, sessionSecretFromEnv } from "../src/lib/security.ts";
import { decryptSecret, encryptSecret } from "../src/lib/secrets.ts";

test("dashboard demo access recognizes only direct loopback addresses and default origins", () => {
  for (const address of ["127.0.0.1", "127.23.4.5", "::1", "::ffff:127.0.0.1"]) assert.equal(isLoopbackAddress(address), true);
  for (const address of [undefined, "localhost", "0.0.0.0", "192.168.1.2", "::ffff:192.168.1.2"]) assert.equal(isLoopbackAddress(address), false);
  assert.deepEqual([...adminOriginsFromEnv()], ["http://127.0.0.1:4321", "http://localhost:4321"]);
  assert.deepEqual([...adminOriginsFromEnv("https://admin.example.com")], ["https://admin.example.com"]);
});

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
