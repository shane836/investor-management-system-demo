import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeMercuryFixture, reconcileMercuryFixtures } from "../lib/integrations/mercury-reconciliation.ts";

const scope = { subscriptionId: "sub-1", entityId: "entity-1", dealId: "deal-1" };
const candidate = { scope, reference: "MEP-SUB-1", expectedAmountCents: 2_500_000,
  gates: { accreditationApproved: true, gpCountersigned: true } };
const event = (changes = {}) => ({ source: "simulated", eventId: "event-1", occurredAt: "2026-10-31T12:00:00Z",
  scope, transactionId: "tx-1", accountRef: "test-account", revision: 1, direction: "incoming",
  status: "posted", amountCents: 2_500_000, reference: "MEP-SUB-1", payerType: "investor", ...changes });
const reconcile = (events, candidates = [candidate]) => reconcileMercuryFixtures(events, candidates);

test("Mercury fixture normalization rejects live markers and drops bank payload details", () => {
  assert.throws(() => normalizeMercuryFixture(event({ source: "live" })), /simulated/);
  const normalized = normalizeMercuryFixture(event({ rawBankAccount: "DO-NOT-RETAIN", secret: "DO-NOT-RETAIN" }));
  assert.equal("rawBankAccount" in normalized, false);
  assert.equal("secret" in normalized, false);
  assert.deepEqual(normalized.scope, scope);
});
test("Money and revision inputs must be positive safe integer values", () => {
  for (const amountCents of [NaN, Infinity, 0, -1, 12.5, Number.MAX_SAFE_INTEGER + 1])
    assert.throws(() => normalizeMercuryFixture(event({ amountCents })), /amountCents/);
  assert.throws(() => normalizeMercuryFixture(event({ revision: 0 })), /revision/);
  assert.throws(() => normalizeMercuryFixture(event({ occurredAt: "bad date" })), /occurredAt/);
});
test("Exact posted reference plus entity/deal scope proposes a match, never acceptance", () => {
  const result = reconcile([event()]);
  assert.equal(result.mode, "simulated");
  assert.equal(result.proposedMatchedCents, 2_500_000);
  assert.equal(result.transactions[0].state, "matched");
  assert.equal(result.transactions[0].accepted, false);
  assert.deepEqual(result.transactions[0].acceptanceBlockers, ["acceptance_policy_pending"]);
});
test("Observed funds do not become posted or matched money", () => {
  const result = reconcile([event({ status: "observed" })]);
  assert.equal(result.transactions[0].state, "observed");
  assert.equal(result.proposedMatchedCents, 0);
});
test("Matching never infers accreditation or countersign approval", () => {
  const result = reconcile([event()], [{ ...candidate, gates: { accreditationApproved: false, gpCountersigned: false } }]);
  assert.equal(result.transactions[0].accepted, false);
  assert.deepEqual(result.transactions[0].acceptanceBlockers,
    ["acceptance_policy_pending", "accreditation_not_approved", "gp_countersign_missing"]);
});
test("Amount alone cannot match a receipt", () => {
  const result = reconcile([event({ reference: null })]);
  assert.equal(result.proposedMatchedCents, 0);
  assert.ok(result.transactions[0].issues.includes("missing_reference"));
});
test("Wrong scope and ambiguous references enter exception review", () => {
  const wrong = reconcile([event({ scope: { ...scope, entityId: "other-entity" } })]);
  assert.ok(wrong.transactions[0].issues.includes("scope_mismatch"));
  const ambiguous = reconcile([event()], [candidate, { ...candidate, scope: { ...scope, subscriptionId: "sub-2" } }]);
  assert.ok(ambiguous.transactions[0].issues.includes("ambiguous_reference"));
  assert.equal(ambiguous.proposedMatchedCents, 0);
});
test("Partial, excess, custodian and third-party receipts remain explicit exceptions", () => {
  for (const [changes, issue] of [[{ amountCents: 1_250_000 }, "partial_receipt"],
    [{ amountCents: 5_000_000 }, "excess_receipt"], [{ payerType: "custodian" }, "custodian_review"],
    [{ payerType: "third_party" }, "third_party_review"], [{ payerType: "unknown" }, "payer_unconfirmed"]]) {
    const result = reconcile([event(changes)]);
    assert.ok(result.transactions[0].issues.includes(issue));
    assert.equal(result.proposedMatchedCents, 0);
  }
});
test("Duplicate delivery is counted once and conflicting event identity fails closed", () => {
  const duplicate = reconcile([event(), event()]);
  assert.equal(duplicate.duplicateEventCount, 1);
  assert.equal(duplicate.proposedMatchedCents, 2_500_000);
  const conflict = reconcile([event(), event({ amountCents: 1_250_000 })]);
  assert.equal(conflict.proposedMatchedCents, 0);
  assert.ok(conflict.transactions[0].issues.includes("conflicting_event_identity"));
});
test("Out-of-order events and polling recovery retain the latest revision", () => {
  const observed = event({ status: "observed" });
  const posted = event({ revision: 2, eventId: "poll-recovery-2", occurredAt: "2026-10-31T12:01:00Z" });
  const first = reconcile([posted, observed]);
  const second = reconcile([observed, posted]);
  assert.deepEqual(first, second);
  assert.equal(first.transactions[0].bankStatus, "posted");
  assert.equal(first.proposedMatchedCents, 2_500_000);
});
test("Conflicting transaction revisions cannot silently pick a match", () => {
  const result = reconcile([event(), event({ eventId: "event-2", amountCents: 1_250_000 })]);
  assert.ok(result.transactions[0].issues.includes("conflicting_transaction_revision"));
  assert.equal(result.proposedMatchedCents, 0);
});
test("Return reverses a previous proposed match even with stale events replayed", () => {
  const returned = event({ eventId: "return-2", revision: 2, status: "returned", occurredAt: "2026-10-31T12:02:00Z" });
  const result = reconcile([returned, event()]);
  assert.equal(result.proposedMatchedCents, 0);
  assert.ok(result.transactions[0].issues.includes("returned_receipt"));
  const invalidRegression = reconcile([returned, event({ eventId: "posted-3", revision: 3 })]);
  assert.equal(invalidRegression.proposedMatchedCents, 0);
  assert.ok(invalidRegression.transactions[0].issues.includes("return_status_regression"));
});
test("Related return transaction removes original receipt from proposed totals", () => {
  const result = reconcile([event(), event({ transactionId: "return-tx", eventId: "return-event", status: "returned", reversesTransactionId: "tx-1" })]);
  assert.equal(result.proposedMatchedCents, 0);
  assert.ok(result.transactions.find(x => x.transactionId === "tx-1").issues.includes("related_return"));
});
test("Multiple full receipts for one investment are excess, not double credit", () => {
  const result = reconcile([event(), event({ eventId: "event-2", transactionId: "tx-2" })]);
  assert.equal(result.proposedMatchedCents, 0);
  assert.ok(result.transactions.every(x => x.issues.includes("multiple_full_receipts")));
});
test("Outgoing records never enter incoming-funding totals", () => {
  const result = reconcile([event({ direction: "outgoing" })]);
  assert.equal(result.proposedMatchedCents, 0);
  assert.ok(result.transactions[0].issues.includes("outgoing_not_funding"));
});

test("Conflicting event identity stays deterministic across duplicate replay order", () => {
  const a = event();
  const b = event({ amountCents: 1_250_000 });
  assert.deepEqual(reconcile([a,b,a]), reconcile([b,a,a]));
});
test("Fixture timestamps must state timezone explicitly", () => {
  assert.throws(() => normalizeMercuryFixture(event({ occurredAt: "2026-10-31T12:00:00" })), /occurredAt/);
});

test("A bank transaction cannot migrate investment scope/reference across revisions", () => {
  const otherScope = { ...scope, subscriptionId: "sub-2", entityId: "entity-2" };
  const changed = event({ eventId: "revision-2", revision: 2, scope: otherScope, reference: "MEP-SUB-2" });
  const candidates = [candidate, { ...candidate, scope: otherScope, reference: "MEP-SUB-2" }];
  const result = reconcile([event(), changed], candidates);
  assert.equal(result.proposedMatchedCents, 0);
  assert.ok(result.transactions[0].issues.includes("transaction_identity_changed"));
  const referenceOnly = reconcile([event(), event({ eventId: "ref-2", revision: 2, reference: "CORRECTED-REF" })],
    [candidate, { ...candidate, reference: "CORRECTED-REF" }]);
  assert.equal(referenceOnly.proposedMatchedCents, 0);
  assert.ok(referenceOnly.transactions[0].issues.includes("transaction_identity_changed"));
});
