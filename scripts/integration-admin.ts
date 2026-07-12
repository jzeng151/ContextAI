import { randomUUID } from "node:crypto";
import { hubSpotOAuthConfigFromEnv, revokeHubSpotRefreshToken } from "../src/lib/integrations.ts";
import { RuntimeStore } from "../src/lib/persistence.ts";
import { secretKeyFromEnv } from "../src/lib/secrets.ts";

const [command, integrationId] = process.argv.slice(2);
const tenantId = process.env.TENANT_ID;
const actorId = process.env.ADMIN_ACTOR_ID;
if (!command || !integrationId || !tenantId || !actorId) {
  throw new Error("usage: integration:admin <status|disconnect> <integration-id> with TENANT_ID and ADMIN_ACTOR_ID");
}

const identity = { requestId: randomUUID(), tenantId, actorId, role: "revops_admin" } as const;
const store = new RuntimeStore();
try {
  if (command === "status") {
    console.log(JSON.stringify(store.getIntegrationStatus(identity, integrationId)));
  } else if (command === "disconnect") {
    const oauth = hubSpotOAuthConfigFromEnv();
    await store.disconnectHubSpotIntegration(identity, integrationId, secretKeyFromEnv(), (token) => revokeHubSpotRefreshToken(token, oauth));
    console.log(`Disconnected ${integrationId}.`);
  } else {
    throw new Error("command must be status or disconnect");
  }
} finally {
  store.close();
}
