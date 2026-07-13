import { randomUUID } from "node:crypto";
import { defaultConfigVersion } from "../src/lib/config.ts";
import { leads } from "../src/data/leads.ts";
import { RuntimeStore } from "../src/lib/persistence.ts";

const store = new RuntimeStore();
const tenantId = process.env.CONTEXTAI_TENANT_ID ?? "local";
const identity = { requestId: "local-seed", tenantId, actorId: "local-admin", role: "revops_admin" } as const;
try {
  if (process.argv[2] === "purge") {
    const tenantId = process.argv[3];
    const before = process.argv[4] ?? new Date().toISOString();
    const actorId = process.env.ADMIN_ACTOR_ID;
    if (!tenantId || !actorId) throw new Error("purge requires a tenant argument and ADMIN_ACTOR_ID");
    const count = store.purgeExpiredEvaluations({ requestId: randomUUID(), tenantId, actorId, role: "revops_admin" }, before);
    console.log(`Purged ${count} expired evaluations for ${tenantId}.`);
  } else if (process.argv.includes("seed")) {
    store.saveTenant(tenantId, "Local demo");
    try {
      store.saveConfigVersion(identity, defaultConfigVersion);
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes("UNIQUE constraint failed")) throw error;
    }
    const existingSeed = store.database.prepare("SELECT evaluation_id FROM evaluation_runs WHERE tenant_id = ? AND idempotency_key = ?");
    const evaluationIdTaken = store.database.prepare("SELECT 1 FROM evaluation_runs WHERE evaluation_id = ?");
    for (const packet of leads) {
      const idempotencyKey = `fixture:${packet.evaluation_id}`;
      const existing = existingSeed.get(tenantId, idempotencyKey) as { evaluation_id: string } | undefined;
      let evaluationId = existing?.evaluation_id ?? `${tenantId}:${packet.evaluation_id}`;
      while (!existing && evaluationIdTaken.get(evaluationId)) evaluationId = randomUUID();
      store.saveEvaluation({
        tenantId,
        idempotencyKey,
        packet: evaluationId === packet.evaluation_id ? packet : { ...packet, evaluation_id: evaluationId }
      });
    }
    console.log(`Seeded ${leads.length} fixture evaluations.`);
  } else {
    console.log("Database migrations are current.");
  }
} finally {
  store.close();
}
