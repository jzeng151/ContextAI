import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";
import { secretKeyFromEnv } from "../src/lib/secrets.ts";
import { sessionSecretFromEnv } from "../src/lib/security.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const envFile = resolve(root, ".env");
const profileFile = resolve(root, "hubspot/src/hsprofile.dev.json");
const stateFile = resolve(root, ".contextai/demo.json");
const astroBin = resolve(root, "node_modules/astro/bin/astro.mjs");
const localApiUrl = "http://127.0.0.1:4000";
const localAstroUrl = "http://127.0.0.1:4321";

type Environment = NodeJS.ProcessEnv;
type Profile = Readonly<{ accountId: number; variables?: Readonly<Record<string, string | number | boolean>> }>;
type DemoState = Readonly<{
  tunnelUrl: string;
  tenantId: string;
  children: Readonly<Record<string, number>>;
}>;

export const tenantIdFromEnvironment = (env: Environment = process.env) => env.CONTEXTAI_TENANT_ID ?? "local";

export const tunnelUrlFromOutput = (output: string) => {
  for (const candidate of output.match(/https:\/\/[^\s"'<>]+/gi) ?? []) {
    try {
      const url = new URL(candidate.replace(/[),.;\]]+$/, ""));
      if (url.protocol === "https:" && /^[a-z0-9-]+\.trycloudflare\.com$/i.test(url.hostname) && !url.port && !url.username && !url.password) {
        return url.origin;
      }
    } catch {
      // Keep scanning cloudflared's mixed log output.
    }
  }
  return undefined;
};

export const demoEnvironment = (env: Environment, tunnelUrl: string): Environment => ({
  ...env,
  HOST: "127.0.0.1",
  PORT: "4000",
  CONTEXTAI_TENANT_ID: tenantIdFromEnvironment(env),
  CONTEXTAI_API_URL: tunnelUrl,
  HUBSPOT_REDIRECT_URI: `${tunnelUrl}/oauth/hubspot/callback`,
  PUBLIC_CONTEXTAI_API_URL: tunnelUrl,
  CONTEXTAI_LOCAL_DEMO: "0",
  ASTRO_TELEMETRY_DISABLED: "1",
});

const exited = (child: ChildProcess) => child.pid === undefined || child.exitCode !== null || child.signalCode !== null;
const waitForExit = (child: ChildProcess) => exited(child)
  ? Promise.resolve()
  : once(child, "close").then(() => undefined);

export const terminateChildren = async (children: readonly ChildProcess[], signal: NodeJS.Signals = "SIGTERM", timeoutMs = 3_000) => {
  const running = children.filter((child) => !exited(child));
  for (const child of running) child.kill(signal);
  let timeout: ReturnType<typeof setTimeout>;
  await Promise.race([
    Promise.all(running.map(waitForExit)),
    new Promise((resolveTimeout) => { timeout = setTimeout(resolveTimeout, timeoutMs); }),
  ]);
  clearTimeout(timeout!);
  const stubborn = running.filter((child) => !exited(child));
  for (const child of stubborn) child.kill("SIGKILL");
  await Promise.all(stubborn.map(waitForExit));
};

const assertNodeVersion = () => {
  const [major, minor] = process.versions.node.split(".").map(Number);
  if ((major ?? 0) < 22 || (major === 22 && (minor ?? 0) < 12)) throw new Error("Node.js 22.12.0 or newer is required");
};

const assertTool = (tool: "cloudflared" | "hs") => {
  const result = spawnSync(tool, ["--version"], { stdio: "ignore" });
  if (result.error || result.status !== 0) throw new Error(`${tool} is required and must be available on PATH`);
};

const loadProfile = (): Profile => {
  if (!existsSync(profileFile)) {
    throw new Error("Missing hubspot/src/hsprofile.dev.json; run `cd hubspot && hs project profile add dev` once with an authenticated HubSpot account");
  }
  let profile: Profile;
  try {
    profile = JSON.parse(readFileSync(profileFile, "utf8")) as Profile;
  } catch {
    throw new Error("hubspot/src/hsprofile.dev.json is not valid JSON");
  }
  if (!Number.isSafeInteger(profile.accountId) || profile.accountId < 1) throw new Error("hubspot/src/hsprofile.dev.json must contain a numeric HubSpot accountId");
  return profile;
};

const loadEnvironment = () => {
  if (!existsSync(envFile)) throw new Error("Missing .env; copy .env.example to .env and add the demo secrets");
  process.loadEnvFile(envFile);
  for (const name of [
    "CONTEXTAI_TENANT_ID",
    "CONTEXTAI_ADMIN_BOOTSTRAP_TOKEN",
    "SESSION_SECRET",
    "INTEGRATION_SECRET_KEY",
    "HUBSPOT_CLIENT_ID",
    "HUBSPOT_CLIENT_SECRET",
    "HUBSPOT_INTEGRATION_ID",
  ]) {
    if (!process.env[name]?.trim()) throw new Error(`${name} is required in .env`);
  }
  sessionSecretFromEnv(process.env.SESSION_SECRET);
  secretKeyFromEnv(process.env.INTEGRATION_SECRET_KEY);
};

const assertPortFree = (port: number) => new Promise<void>((resolvePort, reject) => {
  const server = createServer();
  server.once("error", (error: NodeJS.ErrnoException) => reject(new Error(
    error.code === "EADDRINUSE" ? `Port ${port} is already in use` : `Cannot bind 127.0.0.1:${port}: ${error.message}`,
  )));
  server.listen(port, "127.0.0.1", () => server.close(() => resolvePort()));
});

const preflight = async (checkPorts: boolean) => {
  assertNodeVersion();
  loadEnvironment();
  assertTool("cloudflared");
  assertTool("hs");
  loadProfile();
  if (!existsSync(astroBin)) throw new Error("Dependencies are missing; run `npm ci`");
  if (checkPorts) await Promise.all([assertPortFree(4000), assertPortFree(4321)]);
};

const updateProfile = (tunnelUrl: string) => {
  const { accountId } = loadProfile();
  writeFileSync(profileFile, `${JSON.stringify({ accountId, variables: { CONTEXTAI_API_URL: tunnelUrl } }, null, 2)}\n`, { mode: 0o600 });
};

const waitForTunnel = (child: ChildProcess, timeoutMs = 30_000) => new Promise<string>((resolveTunnel, reject) => {
  let output = "";
  const timeout = setTimeout(() => reject(new Error("cloudflared did not emit a valid https://*.trycloudflare.com URL")), timeoutMs);
  const consume = (chunk: Buffer, stream: NodeJS.WriteStream) => {
    stream.write(chunk);
    output = `${output}${chunk.toString("utf8")}`.slice(-65_536);
    const url = tunnelUrlFromOutput(output);
    if (url) {
      clearTimeout(timeout);
      resolveTunnel(url);
    }
  };
  child.stdout?.on("data", (chunk: Buffer) => consume(chunk, process.stdout));
  child.stderr?.on("data", (chunk: Buffer) => consume(chunk, process.stderr));
  child.once("error", (error) => {
    clearTimeout(timeout);
    reject(new Error(`cloudflared failed to start: ${error.message}`));
  });
  child.once("exit", (code, signal) => {
    clearTimeout(timeout);
    reject(new Error(`cloudflared exited before creating a tunnel (${signal ?? `code ${code}`})`));
  });
});

const waitForHttp = async (url: string, kind: "health" | "astro", timeoutMs = 30_000) => {
  const deadline = Date.now() + timeoutMs;
  let detail = "no response";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(3_000) });
      detail = `HTTP ${response.status}`;
      if (kind === "astro" && response.status >= 200 && response.status < 400) return;
      if (kind === "health" && response.ok && (await response.json() as { status?: string }).status === "ok") return;
    } catch (error) {
      detail = error instanceof Error ? error.message : "request failed";
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
  }
  throw new Error(`${url} is unreachable or unhealthy (${detail})`);
};

const assertTenantState = (env: Environment, state: DemoState) => {
  const tenantId = tenantIdFromEnvironment(env);
  if (state.tenantId !== tenantId) throw new Error(`Demo runtime tenant ${state.tenantId} does not match configured tenant ${tenantId}`);
  const databasePath = resolve(root, env.DATABASE_PATH ?? ".contextai/contextai.sqlite");
  if (!existsSync(databasePath)) throw new Error(`Demo database is missing at ${databasePath}`);
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const count = (sql: string) => (database.prepare(sql).get(tenantId) as { count: number }).count;
    if (count("SELECT count(*) AS count FROM tenants WHERE tenant_id = ?") !== 1) throw new Error(`Configured tenant ${tenantId} is not seeded`);
    if (count("SELECT count(*) AS count FROM config_versions WHERE tenant_id = ? AND status = 'active'") !== 1) throw new Error(`Configured tenant ${tenantId} does not have one active config`);
    if (count("SELECT count(*) AS count FROM evaluation_runs WHERE tenant_id = ? AND idempotency_key LIKE 'fixture:%'") < 1) throw new Error(`Configured tenant ${tenantId} has no seeded fixture evaluations`);
  } finally {
    database.close();
  }
};

const assertChildrenAlive = (state: DemoState) => {
  for (const [name, pid] of Object.entries(state.children)) {
    if (!Number.isSafeInteger(pid) || pid < 1) throw new Error(`Demo state has an invalid ${name} PID`);
    try {
      process.kill(pid, 0);
    } catch {
      throw new Error(`${name} process ${pid} is not running`);
    }
  }
};

const readState = (): DemoState => {
  if (!existsSync(stateFile)) throw new Error("No running demo state found; start `npm run demo` first");
  try {
    const state = JSON.parse(readFileSync(stateFile, "utf8")) as DemoState;
    if (!state || typeof state.tunnelUrl !== "string" || typeof state.tenantId !== "string" || !state.children || typeof state.children !== "object") {
      throw new Error("invalid state");
    }
    return state;
  } catch {
    throw new Error("Demo state is malformed; stop the demo and start it again");
  }
};

const checkDemo = async (env: Environment, state = readState()) => {
  if (!tunnelUrlFromOutput(state.tunnelUrl)) throw new Error("Demo state contains a malformed Quick Tunnel URL");
  assertChildrenAlive(state);
  assertTenantState(env, state);
  await Promise.all([
    waitForHttp(`${localAstroUrl}/`, "astro", 10_000),
    waitForHttp(`${localApiUrl}/health`, "health", 10_000),
    waitForHttp(`${state.tunnelUrl}/health`, "health", 10_000),
  ]);
};

const runOneShot = (command: string, args: readonly string[], options: Readonly<{ cwd?: string; env?: Environment; started?: (child: ChildProcess) => void }> = {}) => new Promise<void>((resolveCommand, reject) => {
  const child = spawn(command, args, { cwd: options.cwd ?? root, env: options.env ?? process.env, stdio: "inherit" });
  options.started?.(child);
  child.once("error", (error) => reject(new Error(`${command} failed to start: ${error.message}`)));
  child.once("exit", (code, signal) => {
    if (code === 0) resolveCommand();
    else reject(new Error(`${command} failed (${signal ?? `code ${code}`})`));
  });
});

const main = async () => {
  const args = new Set(process.argv.slice(2));
  const check = args.delete("check");
  const upload = args.delete("--upload");
  const preflightOnly = args.delete("--preflight");
  if (args.size) throw new Error(`Unknown demo arguments: ${[...args].join(" ")}`);
  if (check && (upload || preflightOnly)) throw new Error("demo:check does not accept --upload or --preflight");

  await preflight(!check && !preflightOnly);
  if (preflightOnly) {
    console.log("Demo preflight passed.");
    return;
  }
  if (check) {
    await checkDemo(process.env);
    console.log("Demo check passed: Astro, local API, tunnel, processes, and seeded tenant/config are healthy.");
    return;
  }

  const children = new Map<ChildProcess, string>();
  let stopping = false;
  let interrupted: NodeJS.Signals | undefined;
  let rejectFatal!: (error: Error) => void;
  const fatal = new Promise<never>((_resolve, reject) => { rejectFatal = reject; });
  const guard = <T>(operation: Promise<T>) => Promise.race([operation, fatal]);
  const start = (name: string, command: string, commandArgs: readonly string[], options: Parameters<typeof spawn>[2]) => {
    const child = spawn(command, commandArgs, options);
    children.set(child, name);
    child.once("error", (error) => {
      if (!stopping) rejectFatal(new Error(`${name} failed to start: ${error.message}`));
    });
    child.once("exit", (code, signal) => {
      if (!stopping) rejectFatal(new Error(`${name} exited unexpectedly (${signal ?? `code ${code}`})`));
    });
    return child;
  };
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      if (interrupted) {
        for (const child of children.keys()) if (!exited(child)) child.kill("SIGKILL");
        return;
      }
      interrupted = signal;
      rejectFatal(new Error(`Received ${signal}`));
    });
  }

  let exitCode = 0;
  try {
    const cloudflared = start("cloudflared", "cloudflared", ["tunnel", "--url", localApiUrl, "--no-autoupdate", "--grace-period", "1s"], {
      cwd: root,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const tunnelUrl = await guard(waitForTunnel(cloudflared));
    const runtimeEnv = demoEnvironment(process.env, tunnelUrl);
    updateProfile(tunnelUrl);

    await guard(runOneShot(process.execPath, ["--experimental-sqlite", "--experimental-strip-types", "scripts/database.ts", "seed"], {
      env: runtimeEnv,
      started: (child) => children.set(child, "database seed"),
    }));
    const api = start("ContextAI API", process.execPath, ["--experimental-sqlite", "--experimental-strip-types", "src/server.ts"], {
      cwd: root,
      env: runtimeEnv,
      stdio: "inherit",
    });
    const astro = start("Astro", process.execPath, [astroBin, "dev", "--host", "127.0.0.1", "--port", "4321"], {
      cwd: root,
      env: runtimeEnv,
      stdio: "inherit",
    });
    const state: DemoState = {
      tunnelUrl,
      tenantId: tenantIdFromEnvironment(runtimeEnv),
      children: { cloudflared: cloudflared.pid!, api: api.pid!, astro: astro.pid! },
    };
    mkdirSync(resolve(root, ".contextai"), { recursive: true });
    writeFileSync(stateFile, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    await guard(checkDemo(runtimeEnv, state));

    console.log("\nHubSpot commands for this Quick Tunnel session (run from hubspot/):");
    console.log("  hs project validate --profile dev");
    console.log("  hs project upload --profile dev");
    console.log("Run both before OAuth; Quick Tunnel hostnames change every session.");
    if (upload) {
      await guard(runOneShot("hs", ["project", "validate", "--profile", "dev"], {
        cwd: resolve(root, "hubspot"), env: runtimeEnv, started: (child) => children.set(child, "HubSpot validation"),
      }));
      await guard(runOneShot("hs", ["project", "upload", "--profile", "dev"], {
        cwd: resolve(root, "hubspot"), env: runtimeEnv, started: (child) => children.set(child, "HubSpot upload"),
      }));
    }
    console.log(`\nContextAI demo is ready at ${localAstroUrl}/login. Press Ctrl-C to stop.`);
    await guard(new Promise<never>(() => {}));
  } catch (error) {
    if (!interrupted) {
      exitCode = 1;
      console.error(`Demo failed: ${error instanceof Error ? error.message : "unknown error"}`);
    }
  } finally {
    stopping = true;
    await terminateChildren([...children.keys()], interrupted ?? "SIGTERM");
    rmSync(stateFile, { force: true });
    process.exitCode = exitCode;
  }
};

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => {
    console.error(`Demo failed: ${error instanceof Error ? error.message : "unknown error"}`);
    process.exitCode = 1;
  });
}
