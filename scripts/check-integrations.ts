import { leads } from "../src/data/leads.ts";
import { explainLeadWithOpenRouter, getHubSpotContact } from "../src/lib/integrations.ts";

const checks: string[] = [];

if (process.env.OPENROUTER_API_KEY) {
  const text = await explainLeadWithOpenRouter(leads[0]);
  checks.push(`OpenRouter ok: ${text.slice(0, 80).replace(/\s+/g, " ")}`);
} else {
  checks.push("OpenRouter skipped: set OPENROUTER_API_KEY");
}

if (process.env.HUBSPOT_ACCESS_TOKEN && process.env.HUBSPOT_CONTACT_ID) {
  const contact = await getHubSpotContact(process.env.HUBSPOT_CONTACT_ID);
  checks.push(`HubSpot ok: contact ${contact.id}`);
} else {
  checks.push("HubSpot skipped: set HUBSPOT_ACCESS_TOKEN and HUBSPOT_CONTACT_ID");
}

console.log(checks.join("\n"));
