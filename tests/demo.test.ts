import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { demoEnvironment, tenantIdFromEnvironment, terminateChildren, tunnelUrlFromOutput } from "../scripts/demo.ts";

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
    const seeded = spawnSync(process.execPath, [
      "--experimental-sqlite",
      "--experimental-strip-types",
      resolve(root, "scripts/database.ts"),
      "seed",
    ], {
      cwd: root,
      env: { ...process.env, CONTEXTAI_TENANT_ID: "demo-tenant", DATABASE_PATH: databasePath },
      encoding: "utf8",
    });
    assert.equal(seeded.status, 0, seeded.stderr);
    const database = new DatabaseSync(databasePath, { readOnly: true });
    try {
      const tenantIds = (table: string) => database.prepare(`SELECT DISTINCT tenant_id FROM ${table}`).all().map((row) => row.tenant_id);
      assert.deepEqual(tenantIds("tenants"), ["demo-tenant"]);
      assert.deepEqual(tenantIds("config_versions"), ["demo-tenant"]);
      assert.deepEqual(tenantIds("evaluation_runs"), ["demo-tenant"]);
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
