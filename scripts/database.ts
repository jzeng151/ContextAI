import { defaultConfigVersion } from "../src/lib/config.ts";
import { leads } from "../src/data/leads.ts";
import { RuntimeStore } from "../src/lib/persistence.ts";

const store = new RuntimeStore();
try {
  if (process.argv.includes("seed")) {
    store.saveTenant("local-demo", "Local demo");
    try {
      store.saveConfigVersion("local-demo", defaultConfigVersion);
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes("UNIQUE constraint failed")) throw error;
    }
    for (const packet of leads) {
      store.saveEvaluation({
        tenantId: "local-demo",
        idempotencyKey: `fixture:${packet.evaluation_id}`,
        packet
      });
    }
    console.log(`Seeded ${leads.length} fixture evaluations.`);
  } else {
    console.log("Database migrations are current.");
  }
} finally {
  store.close();
}
