// Shared internal contract for the locked MVP foundation. Not a vendor schema.
// Fixture adapters are simulated; only existing database guards authorize writes.
export type SubscriptionStatus =
  | "committed" | "accreditation" | "documents" | "funding" | "funded" | "withdrawn" | "rejected";
export type NextActionOwner = "investor" | "gp" | "provider" | "none";
export type JourneyScope = {
  subscriptionId: string;
  entityId: string;
  dealId: string;
};
export type FixtureEventMeta = {
  eventId: string;
  occurredAt: string;
  source: "simulated";
  scope: JourneyScope;
};
export type ApprovalGates = {
  accreditationApproved: boolean;
  gpCountersigned: boolean;
};
export type JourneySnapshot = {
  scope: JourneyScope;
  status: SubscriptionStatus;
  nextActionOwner: NextActionOwner;
  stageEnteredAt: string;
};
export function sameJourneyScope(a: JourneyScope, b: JourneyScope): boolean {
  return a.subscriptionId === b.subscriptionId && a.entityId === b.entityId && a.dealId === b.dealId;
}
export function isTerminalJourney(status: SubscriptionStatus): boolean {
  return status === "funded" || status === "withdrawn" || status === "rejected";
}
