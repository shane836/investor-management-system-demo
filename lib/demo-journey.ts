// Disposable presentation state only. Never persists or authorizes an investment.
import { createFixtureReviewState, applyVerificationSigningFixture, type FixtureReviewState } from './integrations/verification-signing.ts';
import { reconcileMercuryFixtures } from './integrations/mercury-reconciliation.ts';
import { planNotifications } from './operations/notifications.ts';
import type { SubscriptionStatus, NextActionOwner } from './journey-contract.ts';

export const DEMO_STAGES = ['start', 'committed', 'review', 'documents', 'countersign', 'funding', 'matched', 'funded'] as const;
export type DemoStage = typeof DEMO_STAGES[number];
export type DemoAction = 'commit' | 'verify' | 'approve' | 'sign' | 'countersign' | 'match' | 'finish';
export type DemoEntity = 'individual' | 'joint' | 'llc';
export type DemoJourney = {
  stage: DemoStage; entity: DemoEntity; amount: number;
  review: FixtureReviewState; activity: string[];
};
const scope = { subscriptionId: 'demo-investment', entityId: 'demo-entity', dealId: 'demo-sample' };
const actions: Record<DemoAction, { stage: DemoStage; next: DemoStage; message: string }> = {
  commit: { stage: 'start', next: 'committed', message: 'Commitment recorded for the demo.' },
  verify: { stage: 'committed', next: 'review', message: 'Simulated verification evidence received. Sponsor review requested.' },
  approve: { stage: 'review', next: 'documents', message: 'Sponsor approved the demo accreditation.' },
  sign: { stage: 'documents', next: 'countersign', message: 'Simulated signed packet and audit receipt received.' },
  countersign: { stage: 'countersign', next: 'funding', message: 'Sponsor countersigned the demo packet.' },
  match: { stage: 'funding', next: 'matched', message: 'Simulated incoming wire matched. Sponsor review requested.' },
  finish: { stage: 'matched', next: 'funded', message: 'Sponsor marked the demo investment funded. No money moved.' },
};
export function createDemoJourney(entity: string = 'individual', amount = 50000): DemoJourney {
  if (!['individual', 'joint', 'llc'].includes(entity)) throw new Error('This demo route is not available.');
  if (!Number.isFinite(amount) || amount < 50000 || !Number.isSafeInteger(amount * 100)) throw new Error('Enter an amount of at least $50,000 with no more than two decimals.');
  return { stage: 'start', entity: entity as DemoEntity, amount, activity: [], review: createFixtureReviewState({
    scope, ownerUserId: 'demo-investor', verificationRequestId: 'demo-verification', signingRequestId: 'demo-signing',
  }) };
}
export function advanceDemoJourney(state: DemoJourney, action: DemoAction): DemoJourney {
  const transition = actions[action];
  if (!transition || state.stage !== transition.stage) throw new Error('That action is not available at this stage.');
  let review = state.review;
  const receipt = (folder: string) => ({ storagePath: `demo-investor/demo-entity/${folder}/sample.pdf`, sha256: 'a'.repeat(64), byteLength: 1200, mimeType: 'application/pdf' });
  if (action === 'verify' || action === 'sign') {
    const result = applyVerificationSigningFixture(review, {
      source: 'simulated', scope, eventId: `demo-${action}`, occurredAt: '2026-10-28T16:00:00Z',
      ...(action === 'verify'
        ? { kind: 'verification.result', requestId: 'demo-verification', result: 'passed', evidence: receipt('accreditation') }
        : { kind: 'signing.result', requestId: 'demo-signing', status: 'completed', signedPdf: receipt('subscription'), auditTrail: receipt('subscription-audit') }),
    });
    if (result.outcome !== 'applied') throw new Error(result.issues.join('; ') || 'Demo evidence could not be applied.');
    review = result.state;
  }
  return { ...state, review, stage: transition.next, activity: [...state.activity, transition.message] };
}
export function demoBankReport(state: DemoJourney) {
  const matched = state.stage === 'matched' || state.stage === 'funded';
  return reconcileMercuryFixtures(matched ? [{ source: 'simulated', scope, eventId: 'demo-wire', occurredAt: '2026-10-28T17:00:00Z',
    transactionId: 'demo-transaction', accountRef: 'demo-bank', revision: 1, direction: 'incoming', status: 'posted',
    amountCents: state.amount * 100, reference: 'DEMO-SAMPLE', payerType: 'investor' }] : [],
  [{ scope, reference: 'DEMO-SAMPLE', expectedAmountCents: state.amount * 100,
    gates: { accreditationApproved: DEMO_STAGES.indexOf(state.stage) >= 3, gpCountersigned: DEMO_STAGES.indexOf(state.stage) >= 5 } }]);
}
export function demoNotifications(state: DemoJourney) {
  if (state.stage === 'start') return [];
  const status: SubscriptionStatus = ({ committed: 'committed', review: 'accreditation', documents: 'documents',
    countersign: 'documents', funding: 'funding', matched: 'funding', funded: 'funded' } as const)[state.stage];
  const nextActionOwner: NextActionOwner = state.stage === 'funded' ? 'none'
    : ['review', 'countersign', 'matched'].includes(state.stage) ? 'gp' : 'investor';
  return planNotifications({ now: '2026-10-28T17:00:00Z', digestRecipientId: 'demo-sponsor',
    // Fixture timing for previewing reminders after two business days, never a live policy.
    policy: { approved: true, timeZone: 'America/Los_Angeles', sendWindow: { startHour: 8, endHour: 17 }, nudgeBusinessDays: [2, 5], excludedLocalDates: [] },
    journeys: [{ recipientId: 'demo-investor', snapshot: { scope, status, nextActionOwner, stageEnteredAt: '2026-10-26T16:00:00Z' } }],
  }).messages;
}
