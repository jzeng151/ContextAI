import { createServer } from "node:http";
import { RuntimeStore } from "./lib/persistence.ts";
import { createPilotReport, exportPilotReport, reportFiltersFrom } from "./lib/reporting.ts";

const store = new RuntimeStore();
const host = process.env.HOST ?? "127.0.0.1";
const port = Number(process.env.PORT ?? 4000);
if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error("PORT must be an integer from 1 to 65535");

const server = createServer((request, response) => {
  if (request.method === "GET" && request.url === "/health") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ status: "ok" }));
    return;
  }
  if (request.method === "GET" && request.url) {
    try {
      const url = new URL(request.url, `http://${host}`);
      if (url.pathname !== "/reports/pilot" && url.pathname !== "/reports/pilot.csv") throw new Error("not found");
      const tenantId = request.headers["x-contextai-tenant-id"];
      if (typeof tenantId !== "string" || !tenantId.trim()) throw new Error("x-contextai-tenant-id is required");
      const report = createPilotReport(store.database, tenantId, reportFiltersFrom(url.searchParams));
      const csv = url.pathname === "/reports/pilot.csv";
      response.writeHead(200, { "content-type": csv ? "text/csv; charset=utf-8" : "application/json" });
      response.end(csv ? exportPilotReport(report) : JSON.stringify(report));
    } catch (error) {
      if (error instanceof Error && error.message === "not found") {
        response.writeHead(404).end();
        return;
      }
      response.writeHead(400, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
    }
    return;
  }
  response.writeHead(404).end();
});

server.listen(port, host, () => console.log(`ContextAI server listening on http://${host}:${port}`));

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => server.close(() => {
    store.close();
    process.exit(0);
  }));
}
