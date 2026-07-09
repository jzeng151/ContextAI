import { leads } from "../src/data/leads.ts";
import { explainLeadWithOpenRouter, listHubSpotContacts } from "../src/lib/integrations.ts";

const checks: string[] = [];

if (process.env.OPENROUTER_API_KEY) {
  const text = await explainLeadWithOpenRouter(leads[0]);
  checks.push(`OpenRouter ok: ${text.slice(0, 80).replace(/\s+/g, " ")}`);
} else {
  checks.push("OpenRouter skipped: set OPENROUTER_API_KEY");
}

if (process.env.HUBSPOT_ACCESS_TOKEN) {
  const contacts = await listHubSpotContacts(1);
  checks.push(`HubSpot ok: ${contacts.results.length} contact(s) retrieved`);
} else {
  checks.push("HubSpot skipped: set HUBSPOT_ACCESS_TOKEN");
}

console.log(checks.join("\n"));
