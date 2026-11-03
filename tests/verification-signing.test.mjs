import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFixtureReviewState, applyVerificationSigningFixture, assessFixtureReadiness } from '../lib/integrations/verification-signing.ts';

const scope = { subscriptionId: 'sub-one', entityId: 'entity-one', dealId: 'deal-one' };
const config = { scope, ownerUserId: 'owner-one', verificationRequestId: 'verify-one', signingRequestId: 'sign-one' };
const artifact = (kind, name) => ({ storagePath: `owner-one/entity-one/${kind}/${name}.pdf`, sha256: 'a'.repeat(64), byteLength: 1200, mimeType: 'application/pdf' });
const meta = (eventId, occurredAt = '2026-10-31T12:00:00.000Z') => ({ eventId, occurredAt, source: 'simulated', scope: { ...scope } });
const verified = (eventId = 'verification-1') => ({ ...meta(eventId), kind: 'verification.result', requestId: 'verify-one', result: 'passed', evidence: artifact('accreditation', 'letter') });
const signed = (eventId = 'signing-1') => ({ ...meta(eventId), kind: 'signing.result', requestId: 'sign-one', status: 'completed', signedPdf: artifact('subscription', 'final'), auditTrail: artifact('subscription-audit', 'audit') });

test('fixture evidence and signed PDFs only request review; they never approve or fund', () => {
  const initial = createFixtureReviewState(config);
  const evidence = applyVerificationSigningFixture(initial, verified());
  assert.equal(evidence.outcome, 'applied');
  assert.equal(initial.verification.result, 'pending');
  let assessment = assessFixtureReadiness(evidence.state, { accreditationApproved: false, gpCountersigned: false });
  assert.equal(assessment.action, 'review_verification');
  assert.equal(assessment.fundingAuthorized, false);
  const packet = applyVerificationSigningFixture(evidence.state, signed());
  assessment = assessFixtureReadiness(packet.state, { accreditationApproved: true, gpCountersigned: false });
  assert.equal(assessment.action, 'gp_countersign');
  assert.equal(assessment.signingEvidenceReady, true);
  assert.equal(assessment.fundingAuthorized, false);
  assert.equal(assessFixtureReadiness(packet.state, { accreditationApproved: true, gpCountersigned: true }).fundingAuthorized, false);
  assert.equal(assessFixtureReadiness(packet.state, { accreditationApproved: true, gpCountersigned: true }).action, 'review_funding_readiness');
});

test('fixture adapters reject production-looking input, wrong scope and wrong transaction', () => {
  const initial = createFixtureReviewState(config);
  for (const event of [null, { ...verified(), source: 'live' }, { ...verified(), scope: { ...scope, entityId: 'other' } }, { ...signed(), requestId: 'another-signing-request' }]) {
    const result = applyVerificationSigningFixture(initial, event);
    assert.equal(result.outcome, 'exception');
    assert.deepEqual(result.state, initial);
    assert.ok(result.issues.length);
  }
});

test('successful verification requires a scoped private archived receipt, never a temporary URL', () => {
  const initial = createFixtureReviewState(config);
  for (const evidence of [undefined, { ...artifact('accreditation', 'letter'), storagePath: 'https://provider.test/temporary' }, { ...artifact('accreditation', 'letter'), storagePath: 'other/entity-one/accreditation/letter.pdf' }, { ...artifact('accreditation', 'letter'), sha256: '' }, { ...artifact('accreditation', 'letter'), byteLength: 0 }, { ...artifact('accreditation', 'letter'), storagePath: 'owner-one/entity-one/accreditation/../letter.pdf' }]) {
    assert.equal(applyVerificationSigningFixture(initial, { ...verified(), evidence }).outcome, 'exception');
  }
});

test('completed signing requires both final PDF and audit receipt for the expected request', () => {
  const initial = createFixtureReviewState(config);
  assert.equal(applyVerificationSigningFixture(initial, { ...signed(), signedPdf: undefined }).outcome, 'exception');
  assert.equal(applyVerificationSigningFixture(initial, { ...signed(), auditTrail: undefined }).outcome, 'exception');
  const waiting = applyVerificationSigningFixture(initial, { ...meta('waiting-1'), kind: 'signing.result', requestId: 'sign-one', status: 'awaiting_gp' });
  assert.equal(waiting.outcome, 'applied');
  assert.equal(assessFixtureReadiness(waiting.state, { accreditationApproved: true, gpCountersigned: false }).action, 'gp_countersign');
  assert.equal(assessFixtureReadiness(waiting.state, { accreditationApproved: true, gpCountersigned: true }).signingEvidenceReady, false);
});

test('duplicate retries are idempotent and conflicting event reuse is visible', () => {
  const initial = createFixtureReviewState(config);
  const applied = applyVerificationSigningFixture(initial, verified());
  const retry = applyVerificationSigningFixture(applied.state, verified());
  assert.equal(retry.outcome, 'duplicate');
  assert.deepEqual(retry.state, applied.state);
  const conflict = applyVerificationSigningFixture(applied.state, { ...verified(), result: 'failed', evidence: undefined });
  assert.equal(conflict.outcome, 'conflict');
  assert.deepEqual(conflict.state, applied.state);
});

test('out-of-order callbacks and later pending snapshots cannot erase completed artifacts', () => {
  const applied = applyVerificationSigningFixture(createFixtureReviewState(config), signed());
  const stale = { ...meta('old-pending', '2026-10-31T11:59:00.000Z'), kind: 'signing.result', requestId: 'sign-one', status: 'pending' };
  assert.equal(applyVerificationSigningFixture(applied.state, stale).outcome, 'stale');
  const later = { ...stale, ...meta('new-pending', '2026-10-31T12:01:00.000Z') };
  assert.equal(applyVerificationSigningFixture(applied.state, later).outcome, 'exception');
  assert.equal(applied.state.receipts.length, 2);
  assert.equal(applied.state.signing.status, 'completed');
});

test('equal-time differing results require review rather than arbitrary ordering', () => {
  const applied = applyVerificationSigningFixture(createFixtureReviewState(config), verified());
  const conflictingTime = { ...meta('verification-2'), kind: 'verification.result', requestId: 'verify-one', result: 'failed' };
  assert.equal(applyVerificationSigningFixture(applied.state, conflictingTime).outcome, 'conflict');
});

test('invalid dates and unsupported kinds fail visibly; extra approval properties are never copied', () => {
  const initial = createFixtureReviewState(config);
  assert.equal(applyVerificationSigningFixture(initial, { ...verified(), occurredAt: 'not-a-date' }).outcome, 'exception');
  assert.equal(applyVerificationSigningFixture(initial, { ...verified(), kind: 'subscription.funded' }).outcome, 'exception');
  const result = applyVerificationSigningFixture(initial, { ...verified(), accreditationApproved: true, funded: true });
  assert.equal(result.outcome, 'applied');
  assert.equal('funded' in result.state, false);
  assert.equal('accreditationApproved' in result.state, false);
});
