import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { demoEnvironment, tenantIdFromEnvironment, terminateChildren, tunnelUrlFromOutput } from "../scripts/demo.ts";
import { defaultConfigVersion } from "../src/lib/config.ts";
import { leads } from "../src/data/leads.ts";
import { RuntimeStore } from "../src/lib/persistence.ts";

const root = fileURLToPath(new URL("../", import.meta.url));

test("demo derives one tenant/config, parses tunnel output, builds safe env, and cleans up children", async () => {
  assert.equal(tenantIdFromEnvironment({}), "local");
  assert.equal(tenantIdFromEnvironment({ CONTEXTAI_TENANT_ID: "demo-tenant" }), "demo-tenant");

  const tunnelUrl = "https://repeatable-demo.trycloudflare.com";
  assert.equal(tunnelUrlFromOutput(`cloudflared ready: ${tunnelUrl}`), tunnelUrl);
  assert.equal(tunnelUrlFromOutput("https://repeatable-demo.trycloudflare.com.evil"), undefined);
  assert.equal(tunnelUrlFromOutput("http://repeatable-demo.trycloudflare.com"), undefined);

  const input = { CONTEXTAI_TENANT_ID: "demo-tenant", CONTEXTAI_LOCAL_DEMO: "1", KEEP_ME: "yes" };
  const env = demoEnvironment(input, tunnelUrl);
  assert.deepEqual({
    tenant: env.CONTEXTAI_TENANT_ID,
    api: env.CONTEXTAI_API_URL,
    redirect: env.HUBSPOT_REDIRECT_URI,
    publicApi: env.PUBLIC_CONTEXTAI_API_URL,
    localDemo: env.CONTEXTAI_LOCAL_DEMO,
    host: env.HOST,
    port: env.PORT,
    kept: env.KEEP_ME,
  }, {
    tenant: "demo-tenant",
    api: tunnelUrl,
    redirect: `${tunnelUrl}/oauth/hubspot/callback`,
    publicApi: tunnelUrl,
    localDemo: "0",
    host: "127.0.0.1",
    port: "4000",
    kept: "yes",
  });
  assert.equal(input.CONTEXTAI_LOCAL_DEMO, "1");

  const directory = mkdtempSync(join(tmpdir(), "contextai-demo-test-"));
  try {
    const databasePath = join(directory, "contextai.sqlite");
    const legacy = new RuntimeStore(databasePath);
    const legacyIdentity = { requestId: "legacy-seed", tenantId: "local-demo", actorId: "local-admin", role: "revops_admin" } as const;
    legacy.saveTenant(legacyIdentity.tenantId, "Legacy local demo");
    legacy.saveConfigVersion(legacyIdentity, defaultConfigVersion);
    for (const packet of leads) legacy.saveEvaluation({ tenantId: legacyIdentity.tenantId, idempotencyKey: `fixture:${packet.evaluation_id}`, packet });
    const collisionIdentity = { ...legacyIdentity, tenantId: "collision-tenant" };
    legacy.saveTenant(collisionIdentity.tenantId, "Collision fixture");
    legacy.saveConfigVersion(collisionIdentity, defaultConfigVersion);
    legacy.saveEvaluation({ tenantId: collisionIdentity.tenantId, idempotencyKey: "collision", packet: { ...leads[0]!, evaluation_id: `demo-tenant:${leads[0]!.evaluation_id}` } });
    legacy.close();

    const seed = () => spawnSync(process.execPath, ["--experimental-sqlite", "--experimental-strip-types", resolve(root, "scripts/database.ts"), "seed"], {
      cwd: root, env: { ...process.env, CONTEXTAI_TENANT_ID: "demo-tenant", DATABASE_PATH: databasePath }, encoding: "utf8",
    });
    for (const seeded of [seed(), seed()]) assert.equal(seeded.status, 0, seeded.stderr);
    const database = new DatabaseSync(databasePath, { readOnly: true });
    try {
      const tenantIds = (table: string) => database.prepare(`SELECT DISTINCT tenant_id FROM ${table} ORDER BY tenant_id`).all().map((row) => row.tenant_id);
      assert.deepEqual(tenantIds("tenants"), ["collision-tenant", "demo-tenant", "local-demo"]);
      assert.deepEqual(tenantIds("config_versions"), ["collision-tenant", "demo-tenant", "local-demo"]);
      assert.deepEqual(tenantIds("evaluation_runs"), ["collision-tenant", "demo-tenant", "local-demo"]);
      const demoEvaluations = database.prepare("SELECT evaluation_id, packet_json FROM evaluation_runs WHERE tenant_id = ?").all("demo-tenant") as Array<{ evaluation_id: string; packet_json: string }>;
      assert.equal(demoEvaluations.length, leads.length);
      for (const row of demoEvaluations) assert.equal((JSON.parse(row.packet_json) as { evaluation_id: string }).evaluation_id, row.evaluation_id);
    } finally {
      database.close();
    }

    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    await new Promise<void>((resolveSpawn, reject) => {
      child.once("spawn", resolveSpawn);
      child.once("error", reject);
    });
    await terminateChildren([child], "SIGTERM", 1_000);
    assert.ok(child.exitCode !== null || child.signalCode !== null);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
