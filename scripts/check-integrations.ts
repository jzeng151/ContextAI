import { leads } from "../src/data/leads.ts";
import { checkOpenRouterKey, explainLeadWithOpenRouter, listHubSpotContacts } from "../src/lib/integrations.ts";

const checks: string[] = [];

if (process.env.OPENROUTER_API_KEY) {
  try {
    const key = await checkOpenRouterKey();
    checks.push(`OpenRouter ok: ${key.data.label}`);
    if (process.env.OPENROUTER_RUN_COMPLETION === "1") {
      const result = await explainLeadWithOpenRouter(leads[0]);
      checks.push(`OpenRouter completion ok: ${result.explanation.reason.slice(0, 80).replace(/\s+/g, " ")}`);
    }
  } catch (error) {
    checks.push(`OpenRouter failed: ${error instanceof Error ? error.message : String(error)}`);
  }
} else {
  checks.push("OpenRouter skipped: set OPENROUTER_API_KEY");
}

if (process.env.HUBSPOT_ACCESS_TOKEN) {
  try {
    const contacts = await listHubSpotContacts(1);
    checks.push(`HubSpot ok: ${contacts.results.length} contact(s) retrieved`);
  } catch (error) {
    checks.push(`HubSpot failed: ${error instanceof Error ? error.message : String(error)}`);
  }
} else {
  checks.push("HubSpot skipped: set HUBSPOT_ACCESS_TOKEN");
}

console.log(checks.join("\n"));

if (checks.some((check) => check.includes("failed:"))) {
  process.exitCode = 1;
}
