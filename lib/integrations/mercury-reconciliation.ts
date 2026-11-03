import { sameJourneyScope } from "../journey-contract.ts";
import type { ApprovalGates, FixtureEventMeta, JourneyScope } from "../journey-contract.ts";

// Internal simulation contract only. These names/revisions are not a Mercury API
// schema, webhook verifier or production adapter. No API calls or writes occur.
export type MercuryFixtureEvent = FixtureEventMeta & {
  transactionId: string;
  accountRef: string;
  revision: number;
  direction: "incoming" | "outgoing";
  status: "observed" | "posted" | "returned";
  amountCents: number;
  reference: string | null;
  payerType: "investor" | "custodian" | "third_party" | "unknown";
  reversesTransactionId?: string;
};
export type FundingCandidate = {
  scope: JourneyScope;
  reference: string;
  expectedAmountCents: number;
  gates: ApprovalGates;
};
export type ReceiptAssessment = {
  transactionId: string;
  accountRef: string;
  eventId: string;
  scope: JourneyScope;
  bankStatus: MercuryFixtureEvent["status"];
  state: "observed" | "posted" | "matched" | "exception";
  amountCents: number;
  accepted: false;
  issues: string[];
  acceptanceBlockers: string[];
};
export type ReconciliationReport = {
  mode: "simulated";
  acceptancePolicy: "pending";
  transactions: ReceiptAssessment[];
  proposedMatchedCents: number;
  duplicateEventCount: number;
};

function record(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name} must be an object`);
  return value as Record<string, unknown>;
}
function text(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} is required`);
  return value.trim();
}
function positiveInteger(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0)
    throw new Error(`${name} must be a positive safe integer`);
  return value;
}
function scopeOf(value: unknown): JourneyScope {
  const scope = record(value, "scope");
  return { subscriptionId: text(scope.subscriptionId, "subscriptionId"),
    entityId: text(scope.entityId, "entityId"), dealId: text(scope.dealId, "dealId") };
}
function choice<T extends string>(value: unknown, name: string, choices: readonly T[]): T {
  if (!choices.includes(value as T)) throw new Error(`${name} is invalid`);
  return value as T;
}
export function normalizeMercuryFixture(value: unknown): MercuryFixtureEvent {
  const event = record(value, "fixture");
  if (event.source !== "simulated") throw new Error("Only explicit simulated Mercury fixtures are supported");
  const occurredAt = text(event.occurredAt, "occurredAt");
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(occurredAt)
      || !Number.isFinite(Date.parse(occurredAt))) throw new Error("occurredAt must be a valid timestamp with timezone");
  const result: MercuryFixtureEvent = {
    source: "simulated", eventId: text(event.eventId, "eventId"),
    occurredAt: new Date(occurredAt).toISOString(), scope: scopeOf(event.scope),
    transactionId: text(event.transactionId, "transactionId"), accountRef: text(event.accountRef, "accountRef"),
    revision: positiveInteger(event.revision, "revision"),
    direction: choice(event.direction, "direction", ["incoming", "outgoing"]),
    status: choice(event.status, "status", ["observed", "posted", "returned"]),
    amountCents: positiveInteger(event.amountCents, "amountCents"),
    reference: event.reference === null ? null : text(event.reference, "reference"),
    payerType: choice(event.payerType, "payerType", ["investor", "custodian", "third_party", "unknown"]),
  };
  if (event.reversesTransactionId !== undefined)
    result.reversesTransactionId = text(event.reversesTransactionId, "reversesTransactionId");
  // Deliberately whitelist fields; raw bank payloads/account numbers are not kept.
  return result;
}
function normalizeCandidate(value: FundingCandidate): FundingCandidate {
  const candidate = record(value, "candidate");
  const gates = record(candidate.gates, "gates");
  if (typeof gates.accreditationApproved !== "boolean" || typeof gates.gpCountersigned !== "boolean")
    throw new Error("Explicit approval gates are required");
  return { scope: scopeOf(candidate.scope), reference: text(candidate.reference, "reference"),
    expectedAmountCents: positiveInteger(candidate.expectedAmountCents, "expectedAmountCents"),
    gates: { accreditationApproved: gates.accreditationApproved, gpCountersigned: gates.gpCountersigned } };
}
const transactionKey = (account: string, transaction: string) => JSON.stringify([account, transaction]);
const receiptKey = (event: MercuryFixtureEvent) => transactionKey(event.accountRef, event.transactionId);
const bankFactFingerprint = (event: MercuryFixtureEvent) => JSON.stringify({
  scope: event.scope, direction: event.direction, status: event.status,
  amountCents: event.amountCents, reference: event.reference, payerType: event.payerType,
  reversesTransactionId: event.reversesTransactionId,
});

/** Replay a complete fixture set (e.g. webhook + polling recovery) deterministically.
 * Each transaction contributes at most once; results are proposals, never capital
 * acceptance or subscription status updates. Persisted production cursors and API
 * recovery/authentication remain unbuilt and must not be inferred from this model. */
export function reconcileMercuryFixtures(
  inputs: readonly unknown[], candidateInputs: readonly FundingCandidate[],
): ReconciliationReport {
  const candidates = candidateInputs.map(normalizeCandidate);
  const groups = new Map<string, MercuryFixtureEvent[]>();
  const identities = new Map<string, Map<string, MercuryFixtureEvent>>();
  const identityConflicts = new Set<string>();
  let duplicateEventCount = 0;
  for (const input of inputs) {
    const event = normalizeMercuryFixture(input);
    const variants = identities.get(event.eventId) ?? new Map<string, MercuryFixtureEvent>();
    const fingerprint = JSON.stringify(event);
    if (variants.has(fingerprint)) { duplicateEventCount++; continue; }
    if (variants.size) {
      for (const prior of variants.values()) identityConflicts.add(receiptKey(prior));
      identityConflicts.add(receiptKey(event));
    }
    variants.set(fingerprint, event);
    identities.set(event.eventId, variants);
    const key = receiptKey(event);
    groups.set(key, [...(groups.get(key) ?? []), event]);
  }
  const selected = new Map<string, { event: MercuryFixtureEvent; issues: string[] }>();
  for (const [key, events] of groups) {
    const ordered = [...events].sort((a, b) => b.revision - a.revision
      || b.occurredAt.localeCompare(a.occurredAt) || a.eventId.localeCompare(b.eventId)
      || bankFactFingerprint(a).localeCompare(bankFactFingerprint(b)));
    let event = ordered[0];
    const issues: string[] = identityConflicts.has(key) ? ["conflicting_event_identity"] : [];
    const investmentIdentities = new Set(ordered.map(item => JSON.stringify({ scope: item.scope, reference: item.reference })));
    // A correction may be legitimate, but reassignment of a receipt requires
    // review rather than silently crediting a different investment/reference.
    if (investmentIdentities.size > 1) issues.push("transaction_identity_changed");
    const revisions = new Map<number, string>();
    for (const item of ordered) {
      const fact = bankFactFingerprint(item);
      if (revisions.has(item.revision) && revisions.get(item.revision) !== fact) {
        if (!issues.includes("conflicting_transaction_revision")) issues.push("conflicting_transaction_revision");
      } else revisions.set(item.revision, fact);
    }
    // A stale/replayed posting cannot restore money after a recorded return.
    const returned = ordered.find(item => item.status === "returned");
    if (returned && event.status !== "returned") { event = returned; issues.push("return_status_regression"); }
    selected.set(key, { event, issues });
  }
  const reversed = new Set<string>();
  for (const { event } of selected.values()) {
    if (event.status === "returned" && event.reversesTransactionId)
      reversed.add(transactionKey(event.accountRef, event.reversesTransactionId));
  }
  const transactions: ReceiptAssessment[] = [];
  const matchCandidates = new Map<ReceiptAssessment, FundingCandidate>();
  for (const [key, selectedEvent] of [...selected.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const { event } = selectedEvent;
    const issues = [...selectedEvent.issues];
    if (event.direction !== "incoming") issues.push("outgoing_not_funding");
    if (event.status === "returned") issues.push("returned_receipt");
    if (reversed.has(key)) issues.push("related_return");
    if (event.status === "returned" && event.reversesTransactionId
        && !selected.has(transactionKey(event.accountRef, event.reversesTransactionId)))
      issues.push("return_target_not_in_fixture_set");
    const byReference = event.reference ? candidates.filter(c => c.reference === event.reference) : [];
    let candidate: FundingCandidate | undefined;
    if (!event.reference) issues.push("missing_reference");
    else if (byReference.length === 0) issues.push("unmatched_reference");
    else if (byReference.length > 1) issues.push("ambiguous_reference");
    else if (!sameJourneyScope(byReference[0].scope, event.scope)) issues.push("scope_mismatch");
    else candidate = byReference[0];
    if (candidate) {
      if (event.amountCents < candidate.expectedAmountCents) issues.push("partial_receipt");
      if (event.amountCents > candidate.expectedAmountCents) issues.push("excess_receipt");
    }
    if (event.payerType === "custodian") issues.push("custodian_review");
    if (event.payerType === "third_party") issues.push("third_party_review");
    if (event.payerType === "unknown") issues.push("payer_unconfirmed");
    const acceptanceBlockers = ["acceptance_policy_pending"];
    if (candidate && !candidate.gates.accreditationApproved) acceptanceBlockers.push("accreditation_not_approved");
    if (candidate && !candidate.gates.gpCountersigned) acceptanceBlockers.push("gp_countersign_missing");
    const assessment: ReceiptAssessment = {
      transactionId: event.transactionId, accountRef: event.accountRef, eventId: event.eventId, scope: event.scope,
      bankStatus: event.status, amountCents: event.amountCents, accepted: false, issues, acceptanceBlockers,
      state: issues.length ? "exception" : event.status === "observed" ? "observed" : "matched",
    };
    transactions.push(assessment);
    if (assessment.state === "matched" && candidate) matchCandidates.set(assessment, candidate);
  }
  // Distinct bank IDs may represent duplicate full payments. Do not double credit
  // an investment merely because both records match its reference and amount.
  const perInvestment = new Map<string, ReceiptAssessment[]>();
  for (const [assessment, candidate] of matchCandidates) {
    const key = JSON.stringify(candidate.scope);
    perInvestment.set(key, [...(perInvestment.get(key) ?? []), assessment]);
  }
  for (const receipts of perInvestment.values()) if (receipts.length > 1) {
    for (const receipt of receipts) { receipt.state = "exception"; receipt.issues.push("multiple_full_receipts"); }
  }
  let proposedMatchedCents = 0;
  for (const receipt of transactions) if (receipt.state === "matched") {
    proposedMatchedCents += receipt.amountCents;
    if (!Number.isSafeInteger(proposedMatchedCents)) throw new Error("Proposed total exceeds safe integer cents");
  }
  return { mode: "simulated", acceptancePolicy: "pending", transactions, proposedMatchedCents, duplicateEventCount };
}
