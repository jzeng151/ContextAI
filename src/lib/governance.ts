import type { LeadPacket, ManualReviewReason } from "./contextai.ts";

export type GovernanceReviewReason = ManualReviewReason | "stale_enrichment" | "candidate_writeback_blocked" | "candidate_writeback_flagged";

export const governanceReviewReasons = (packet: LeadPacket): readonly GovernanceReviewReason[] => {
  const reasons = new Set<GovernanceReviewReason>(packet.manual_review_reasons);
  if (packet.stale_fields.length > 0) reasons.add("stale_enrichment");
  if (packet.writeback_plan?.decision === "Blocked") reasons.add("candidate_writeback_blocked");
  if (packet.writeback_plan?.decision === "Review") reasons.add("candidate_writeback_flagged");
  return [...reasons];
};
