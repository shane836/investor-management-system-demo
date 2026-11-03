import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDemoJourney, advanceDemoJourney, demoNotifications, demoBankReport } from '../lib/demo-journey.ts';

test('demo walks through evidence, separate GP decisions and a simulated funding result', () => {
  let state = createDemoJourney('llc', 100000);
  for (const action of ['commit', 'verify', 'approve', 'sign', 'countersign', 'match', 'finish']) {
    state = advanceDemoJourney(state, action);
  }
  assert.equal(state.stage, 'funded');
  assert.equal(state.review.source, 'simulated');
  assert.equal(state.review.receipts.length, 3);
  assert.equal(demoBankReport(state).transactions[0].accepted, false);
  assert.deepEqual(demoNotifications(state), []);
  assert.equal(state.activity.length, 7);
});

test('demo cannot skip GP approval, signing or funding matching', () => {
  const initial = createDemoJourney();
  for (const action of ['approve', 'sign', 'countersign', 'match', 'finish']) {
    assert.throws(() => advanceDemoJourney(initial, action), /not available/);
  }
  assert.equal(initial.stage, 'start');
  assert.equal(initial.activity.length, 0);
});

test('demo prevents unsupported IRA routing and invalid commitments', () => {
  assert.throws(() => createDemoJourney('ira'), /not available/);
  for (const amount of [0, 12500, NaN, Infinity, 50000.001]) {
    assert.throws(() => createDemoJourney('individual', amount), /amount/);
  }
});

test('mock reminders follow the current action owner and stop at completion', () => {
  let state = advanceDemoJourney(createDemoJourney(), 'commit');
  assert.ok(demoNotifications(state).some(m => m.kind === 'investor_nudge'));
  state = advanceDemoJourney(state, 'verify');
  assert.deepEqual(demoNotifications(state).map(m => m.kind), ['gp_digest']);
  assert.equal(demoBankReport(state).transactions.length, 0);
  assert.equal(createDemoJourney().stage, 'start');
});
