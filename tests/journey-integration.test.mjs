// Cross-stream simulated workflow tests, not a live vendor/browser E2E test.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createFixtureReviewState, applyVerificationSigningFixture, assessFixtureReadiness } from "../lib/integrations/verification-signing.ts";
import { reconcileMercuryFixtures } from "../lib/integrations/mercury-reconciliation.ts";
import { planNotifications, enqueueMockNotifications, deliverMockNotification } from "../lib/operations/notifications.ts";

const scope = { subscriptionId: "sub-one", entityId: "entity-one", dealId: "deal-one" };
const config = { scope, ownerUserId: "owner-one", verificationRequestId: "verify-one", signingRequestId: "sign-one" };
const now = "2026-10-28T17:00:00Z";
// Test-only timing, not approval of the proposed live reminder schedule.
const policy = { approved: true, timeZone: "America/Los_Angeles", sendWindow: { startHour: 8, endHour: 17 }, nudgeBusinessDays: [2,5], excludedLocalDates: [] };
const receipt = folder => ({ storagePath: `owner-one/entity-one/${folder}/fixture.pdf`, sha256: "a".repeat(64), byteLength: 1200, mimeType: "application/pdf" });
const verification = { source: "simulated", eventId: "verify-event", occurredAt: "2026-10-28T16:00:00Z", scope, kind: "verification.result", requestId: "verify-one", result: "passed", evidence: receipt("accreditation") };
const signing = { source: "simulated", eventId: "sign-event", occurredAt: "2026-10-28T16:01:00Z", scope, kind: "signing.result", requestId: "sign-one", status: "completed", signedPdf: receipt("subscription"), auditTrail: receipt("subscription-audit") };
const bank = { source: "simulated", eventId: "bank-event", occurredAt: now, scope, transactionId: "tx-one", accountRef: "sandbox-account", revision: 1, direction: "incoming", status: "posted", amountCents: 2500000, reference: "MEP-SUB-ONE", payerType: "investor" };
const candidate = gates => ({ scope, reference: "MEP-SUB-ONE", expectedAmountCents: 2500000, gates });
const journey = (status, nextActionOwner) => ({ recipientId: "owner-one", snapshot: { scope, status, nextActionOwner, stageEnteredAt: "2026-10-26T16:00:00Z" } });
function evidenceReady() {
  let state = createFixtureReviewState(config);
  state = applyVerificationSigningFixture(state, verification).state;
  return applyVerificationSigningFixture(state, signing).state;
}

test("simulated evidence, signing and posted funds never bypass GP approval or acceptance policy", () => {
  const state = evidenceReady(), gates = { accreditationApproved: false, gpCountersigned: false };
  const readiness = assessFixtureReadiness(state, gates);
  assert.equal(readiness.action, "review_verification");
  assert.equal(readiness.fundingAuthorized, false);
  const report = reconcileMercuryFixtures([bank], [candidate(gates)]);
  assert.equal(report.transactions[0].state, "matched");
  assert.equal(report.transactions[0].accepted, false);
  assert.deepEqual(report.transactions[0].acceptanceBlockers, ["acceptance_policy_pending", "accreditation_not_approved", "gp_countersign_missing"]);
  const messages = planNotifications({ now, policy, journeys: [journey("accreditation", readiness.nextActionOwner)], digestRecipientId: "gp-one" }).messages;
  assert.equal(messages.filter(m => m.kind === "investor_nudge").length, 0);
  assert.equal(messages.filter(m => m.kind === "gp_digest").length, 1);
  assert.equal(assessFixtureReadiness(state, { accreditationApproved: true, gpCountersigned: false }).action, "gp_countersign");
  assert.equal(assessFixtureReadiness(state, { accreditationApproved: true, gpCountersigned: true }).fundingAuthorized, false);
});

test("provider and bank retries deduplicate; a later return removes the proposed match", () => {
  const state = evidenceReady();
  const retry = applyVerificationSigningFixture(state, signing);
  assert.equal(retry.outcome, "duplicate");
  assert.deepEqual(retry.state, state);
  const gates = { accreditationApproved: true, gpCountersigned: true };
  const posted = reconcileMercuryFixtures([bank, bank], [candidate(gates)]);
  assert.equal(posted.proposedMatchedCents, 2500000);
  assert.equal(posted.duplicateEventCount, 1);
  const returned = { ...bank, eventId: "bank-return", revision: 2, status: "returned", occurredAt: "2026-10-28T18:00:00Z" };
  const recovered = reconcileMercuryFixtures([returned, bank, bank], [candidate(gates)]);
  assert.equal(recovered.proposedMatchedCents, 0);
  assert.equal(recovered.transactions[0].accepted, false);
  assert.ok(recovered.transactions[0].issues.includes("returned_receipt"));
  const notices = planNotifications({ now, policy, journeys: [journey("funding", "gp")], digestRecipientId: "gp-one" });
  assert.equal(notices.messages.filter(m => m.kind === "investor_nudge").length, 0);
  assert.equal(notices.messages[0].kind, "gp_digest");
});

test("mismatched identities and missing PDF evidence remain exceptions across streams", () => {
  const initial = createFixtureReviewState(config);
  const wrong = applyVerificationSigningFixture(initial, { ...verification, scope: { ...scope, entityId: "other-entity" } });
  assert.equal(wrong.outcome, "exception");
  assert.deepEqual(wrong.state, initial);
  assert.equal(applyVerificationSigningFixture(initial, { ...signing, signedPdf: undefined }).outcome, "exception");
  const report = reconcileMercuryFixtures([{ ...bank, scope: { ...scope, entityId: "other-entity" } }], [candidate({ accreditationApproved: false, gpCountersigned: false })]);
  assert.equal(report.proposedMatchedCents, 0);
  assert.equal(report.transactions[0].state, "exception");
  assert.ok(report.transactions[0].issues.includes("scope_mismatch"));
});

test("queued mock nudges stop on owner change/completion; defaults never enable delivery", () => {
  const active = [journey("committed", "investor")];
  assert.deepEqual(planNotifications({ now, journeys: active, digestRecipientId: "gp-one" }).messages, []);
  const planned = planNotifications({ now, policy, journeys: active, digestRecipientId: "gp-one" }).messages;
  const box = enqueueMockNotifications({}, planned);
  assert.deepEqual(enqueueMockNotifications(box, planned), box);
  const nudge = planned.find(m => m.kind === "investor_nudge");
  assert.ok(nudge);
  for (const currentJourneys of [[journey("committed", "gp")], [journey("funded", "none")]]) {
    const delivered = deliverMockNotification(box, { dedupeKey: nudge.dedupeKey, attemptId: "attempt-stop", outcome: "success", currentJourneys, now, policy, maxAttempts: 2 });
    assert.equal(delivered[nudge.dedupeKey].status, "cancelled");
    assert.equal(delivered[nudge.dedupeKey].attempts, 0);
  }
  const disabled = deliverMockNotification(box, { dedupeKey: nudge.dedupeKey, attemptId: "attempt-disabled", outcome: "success", currentJourneys: active, now, maxAttempts: 2 });
  assert.equal(disabled[nudge.dedupeKey].attempts, 0);
  assert.equal(disabled[nudge.dedupeKey].lastError, "timing_not_approved");
});

test("mock delivery retries and bounce outcomes remain visible without retaining raw sensitive payloads", () => {
  const secret = "RAW-WIRE-DETAILS-NEVER-FORWARD";
  const active = [{ ...journey("documents", "investor"), wireInstructions: secret }];
  const planned = planNotifications({ now, policy, journeys: active, digestRecipientId: "gp-one" }).messages;
  const nudge = planned.find(m => m.kind === "investor_nudge");
  let box = enqueueMockNotifications({}, planned.map(m => ({ ...m, body: secret, bankPayload: secret })));
  assert.equal(JSON.stringify(box).includes(secret), false);
  const request = { dedupeKey: nudge.dedupeKey, attemptId: "attempt-fail", outcome: "temporary_failure", currentJourneys: active, now, policy, maxAttempts: 2 };
  box = deliverMockNotification(box, request);
  assert.equal(box[nudge.dedupeKey].status, "failed");
  assert.deepEqual(deliverMockNotification(box, request), box);
  box = deliverMockNotification(box, { ...request, attemptId: "attempt-bounce", outcome: "bounce" });
  assert.equal(box[nudge.dedupeKey].status, "bounced");
  assert.equal(box[nudge.dedupeKey].attempts, 2);
  assert.equal(reconcileMercuryFixtures([{ ...bank, rawBankPayload: secret }], [candidate({ accreditationApproved: true, gpCountersigned: true })]).transactions[0].accepted, false);
  assert.equal(JSON.stringify(applyVerificationSigningFixture(createFixtureReviewState(config), { ...verification, rawProviderPayload: secret }).state).includes(secret), false);
});
