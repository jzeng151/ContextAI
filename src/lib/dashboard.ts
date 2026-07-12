import type { LeadPacket } from "./contextai.ts";
import { assertPilotEvent, type ActionType, type PilotEvent } from "./instrumentation.ts";
import type { RuntimeStore } from "./persistence.ts";
import type { RequestIdentity } from "./security.ts";

export const dashboardPromptVersion = "grounding-v1";

export type DashboardOutcomePacket = Readonly<Pick<
  LeadPacket,
  "request_id" | "evaluation_id" | "lead_id" | "account_id" | "score_version"
>>;
export type DashboardViewPacket = DashboardOutcomePacket & Readonly<Pick<
  LeadPacket,
  "priority_score" | "priority_band"
>>;

type DashboardEventInput<Packet> = {
  packet: Packet;
  tenantId: string;
  actorType: PilotEvent["actorType"];
  actorId: string;
  configVersion: string;
  occurredAt: string;
  idempotencySeed: string;
};

export type DashboardOutcomeInput = DashboardEventInput<DashboardOutcomePacket> & {
  disposition: Extract<PilotEvent, { name: "recommendation.disposition" }>[
    "data"
  ]["disposition"];
  actionType?: ActionType;
};
export type DashboardViewInput = DashboardEventInput<DashboardViewPacket>;

const eventBase = ({
  packet, tenantId, actorType, actorId, configVersion, occurredAt
}: DashboardEventInput<DashboardOutcomePacket>) => ({
  tenantId,
  requestId: packet.request_id,
  evaluationId: packet.evaluation_id,
  leadId: packet.lead_id,
  accountId: packet.account_id,
  actorType,
  actorId,
  scoreVersion: packet.score_version,
  configVersion,
  promptVersion: dashboardPromptVersion,
  evidenceRefs: [],
  retentionClass: "pilot_analytics_12_months" as const,
  occurredAt
});

export const dashboardOutcomeEvents = (input: DashboardOutcomeInput): PilotEvent[] => {
  const { disposition, actionType, idempotencySeed } = input;
  const base = eventBase(input);
  const events: PilotEvent[] = [{
    ...base,
    idempotencyKey: `${idempotencySeed}:recommendation.disposition`,
    name: "recommendation.disposition",
    data: actionType ? { disposition, actionType } : { disposition }
  }];

  if (actionType) events.push({
    ...base,
    idempotencyKey: `${idempotencySeed}:action.first_meaningful`,
    name: "action.first_meaningful",
    data: { actionType }
  });

  events.forEach(assertPilotEvent);
  return events;
};

export const dashboardViewEvents = (input: DashboardViewInput): PilotEvent[] => {
  const { packet, idempotencySeed } = input;
  const base = eventBase(input);
  const events: PilotEvent[] = [{
    ...base,
    idempotencyKey: `${idempotencySeed}:lead.viewed`,
    name: "lead.viewed",
    data: { surface: "dashboard" }
  }, {
    ...base,
    idempotencyKey: `${idempotencySeed}:score.shown`,
    name: "score.shown",
    data: {
      priorityScore: packet.priority_score,
      priorityBand: packet.priority_band,
      surface: "dashboard"
    }
  }];

  events.forEach(assertPilotEvent);
  return events;
};

export const hubSpotDashboardPackets = (store: RuntimeStore, identity: RequestIdentity, contactIds: readonly string[]) =>
  contactIds.flatMap((contactId) => store.getLatestEvaluationForCrmRecord(identity, "0-1", contactId)?.packet ?? []);
