import type { HubSpotContact } from "./integrations.ts";
import { buildLeadPacketFromSources, type CrmLeadSeed } from "./leadPipeline.ts";
import type { LeadPacket } from "./contextai.ts";

const domainFromEmail = (email: string) => {
  const at = email.indexOf("@");
  return at > -1 ? email.slice(at + 1).toLowerCase() : "unknown.local";
};

const displayName = (contact: HubSpotContact) => {
  const first = contact.properties.firstname?.trim() ?? "";
  const last = contact.properties.lastname?.trim() ?? "";
  const full = `${first} ${last}`.trim();
  if (full) return full;
  return contact.properties.email?.trim() || `Contact ${contact.id}`;
};

export const hubSpotContactToSeed = (contact: HubSpotContact): CrmLeadSeed => {
  const email = contact.properties.email?.trim() || `contact-${contact.id}@hubspot.local`;
  return {
    lead_id: `hubspot-${contact.id}`,
    account_id: `acct-${contact.id}`,
    name: displayName(contact),
    title: contact.properties.jobtitle?.trim() || "Data unavailable",
    company: contact.properties.company?.trim() || "Unknown Company",
    email,
    domain: domainFromEmail(email),
    owner: contact.properties.hubspot_owner_id?.trim() || "Unassigned",
    source: contact.properties.hs_analytics_source?.trim() || "HubSpot CRM",
    stage: contact.properties.lifecyclestage?.trim() || "Unknown",
  };
};

/** get_crm_lead → enrich → intent → public → score. Writeback stubbed read-only. */
export const hubSpotContactToLeadPacket = async (contact: HubSpotContact): Promise<LeadPacket> => {
  const { lead } = await buildLeadPacketFromSources(hubSpotContactToSeed(contact));
  return lead;
};

export const hubSpotContactsToLeadPackets = async (contacts: HubSpotContact[]): Promise<LeadPacket[]> =>
  Promise.all(contacts.map(hubSpotContactToLeadPacket));
