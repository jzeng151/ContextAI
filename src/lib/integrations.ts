import type { LeadPacket } from "./contextai";

type Env = Record<string, string | undefined>;

export type OpenRouterConfig = {
  apiKey: string;
  model: string;
  appUrl?: string;
};

export type HubSpotConfig = {
  accessToken: string;
};

export type HubSpotContact = {
  id: string;
  properties: Record<string, string | null>;
  archived?: boolean;
};

export type HubSpotContactList = {
  results: HubSpotContact[];
  paging?: { next?: { after: string; link: string } };
};

const requireEnv = (env: Env, name: string) => {
  const value = env[name];
  if (!value) throw new Error(`Missing ${name}`);
  return value;
};

export const openRouterConfigFromEnv = (env: Env = process.env): OpenRouterConfig => ({
  apiKey: requireEnv(env, "OPENROUTER_API_KEY"),
  model: env.OPENROUTER_MODEL || "openai/gpt-4.1-mini",
  appUrl: env.CONTEXTAI_APP_URL
});

export const hubSpotConfigFromEnv = (env: Env = process.env): HubSpotConfig => ({
  accessToken: requireEnv(env, "HUBSPOT_ACCESS_TOKEN")
});

const readJson = async <T>(response: Response): Promise<T> => {
  const text = await response.text();
  const body = text ? JSON.parse(text) : {};
  if (!response.ok) {
    const message = typeof body.message === "string" ? body.message : response.statusText;
    throw new Error(`${response.status} ${message}`);
  }
  return body as T;
};

export const explainLeadWithOpenRouter = async (
  lead: LeadPacket,
  config = openRouterConfigFromEnv()
) => {
  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${config.apiKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": config.appUrl || "http://127.0.0.1:4321",
      "X-Title": "ContextAI"
    },
    body: JSON.stringify({
      model: config.model,
      messages: [
        {
          role: "system",
          content: "You are ContextAI. Explain the provided deterministic score. Do not calculate a score, invent facts, or draft a full email."
        },
        {
          role: "user",
          content: JSON.stringify({
            score: lead.score,
            band: lead.band,
            confidence: lead.confidence,
            scoreBreakdown: lead.scoreBreakdown,
            enrichment: lead.enrichment,
            intent: lead.intent,
            publicSignal: lead.publicSignal,
            missingOrStale: lead.missingOrStale
          })
        }
      ],
      temperature: 0.2,
      max_completion_tokens: 220
    })
  });

  const json = await readJson<{ choices?: Array<{ message?: { content?: string } }> }>(response);
  const content = json.choices?.[0]?.message?.content?.trim();
  if (!content) throw new Error("OpenRouter returned no message content");
  return content;
};

const contactProperties = [
  "email",
  "firstname",
  "lastname",
  "company",
  "jobtitle",
  "hubspot_owner_id",
  "lifecyclestage",
  "hs_analytics_source"
].join(",");

export const listHubSpotContacts = async (
  limit = 10,
  config = hubSpotConfigFromEnv()
) => {
  const url = new URL("https://api.hubapi.com/crm/v3/objects/contacts");
  url.searchParams.set("limit", String(limit));
  url.searchParams.set("properties", contactProperties);
  url.searchParams.set("archived", "false");

  const response = await fetch(url, {
    headers: { "Authorization": `Bearer ${config.accessToken}` }
  });
  return readJson<HubSpotContactList>(response);
};

export const getHubSpotContact = async (
  contactId: string,
  config = hubSpotConfigFromEnv()
) => {
  const url = new URL(`https://api.hubapi.com/crm/v3/objects/contacts/${contactId}`);
  url.searchParams.set("properties", contactProperties);
  url.searchParams.set("archived", "false");

  const response = await fetch(url, {
    headers: { "Authorization": `Bearer ${config.accessToken}` }
  });
  return readJson<HubSpotContact>(response);
};

export const writeHubSpotEnrichment = async (
  contactId: string,
  properties: Record<string, string>,
  config = hubSpotConfigFromEnv()
) => {
  if (Object.keys(properties).length === 0) throw new Error("No HubSpot properties to write");
  const response = await fetch(`https://api.hubapi.com/crm/v3/objects/contacts/${contactId}`, {
    method: "PATCH",
    headers: {
      "Authorization": `Bearer ${config.accessToken}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ properties })
  });
  return readJson<HubSpotContact>(response);
};
