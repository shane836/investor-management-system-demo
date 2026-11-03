import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planNotifications, enqueueMockNotifications, deliverMockNotification } from '../lib/operations/notifications.ts';

const scope = {subscriptionId:'sub-1',entityId:'entity-1',dealId:'deal-1'};
const journey = (overrides = {}) => ({snapshot:{scope,status:'committed',nextActionOwner:'investor',stageEnteredAt:'2026-10-26T16:00:00Z',...overrides},recipientId:'lp-1'});
const policy = {approved:true,timeZone:'America/Los_Angeles',sendWindow:{startHour:8,endHour:17},nudgeBusinessDays:[2,5],excludedLocalDates:[]};
const now = '2026-10-28T17:00:00Z';
const plan = (journeys = [journey()], date = now, config = policy) => planNotifications({now:date,journeys,policy:config,digestRecipientId:'gp-1'});
const nudge = () => plan().messages.find(m=>m.kind==='investor_nudge');
const deliver = (outbox,key,attemptId,outcome='success',journeys=[journey()],date=now,config=policy) => deliverMockNotification(outbox,{dedupeKey:key,attemptId,outcome,currentJourneys:journeys,now:date,policy:config,maxAttempts:2});

test('notifications remain disabled without explicit timing approval', () => {
  assert.equal(planNotifications({now,journeys:[journey()],digestRecipientId:'gp-1'}).messages.length,0);
  assert.equal(plan([journey()],now,{...policy,approved:false}).messages.length,0);
});
test('approved weekday window and configured exclusions control planning', () => {
  assert.equal(plan([journey()],'2026-10-31T17:00:00Z').messages.length,0);
  assert.equal(plan([journey()],'2026-10-28T13:00:00Z').messages.length,0);
  assert.equal(plan([journey()],now,{...policy,excludedLocalDates:['2026-10-28']}).messages.length,0);
  assert.equal(plan().messages.length,2);
});
test('planner uses business dates across weekends and DST, without inventing holidays', () => {
  const start = journey({stageEnteredAt:'2026-10-30T16:00:00Z'});
  assert.equal(plan([start],'2026-11-02T18:00:00Z').messages.filter(m=>m.kind==='investor_nudge').length,0);
  assert.equal(plan([start],'2026-11-03T18:00:00Z').messages.find(m=>m.kind==='investor_nudge').businessDays,2);
  assert.equal(plan([journey()],'2026-11-04T18:00:00Z').messages.find(m=>m.kind==='investor_nudge').thresholdBusinessDays,5);
});
test('funded, withdrawn, rejected and other action owners stop investor nudges', () => {
  for (const status of ['funded','withdrawn','rejected']) assert.equal(plan([journey({status})]).messages.length,0);
  for (const nextActionOwner of ['gp','provider','none']) {
    const messages=plan([journey({nextActionOwner})]).messages;
    assert.equal(messages.filter(m=>m.kind==='investor_nudge').length,0);
    assert.equal(messages.filter(m=>m.kind==='gp_digest').length,1);
  }
});
test('generated messages whitelist data rather than forwarding private payloads', () => {
  const unsafe={...journey(),wireInstructions:'SECRET-WIRE',privateEvidence:'SECRET-PDF',bankAccount:'SECRET-ACCOUNT'};
  const messages=plan([unsafe]).messages;
  assert.doesNotMatch(JSON.stringify(messages),/SECRET|wireInstructions|bankAccount|privateEvidence/);
  assert.equal(messages.find(m=>m.kind==='gp_digest').entries[0].nextActionOwner,'investor');
  assert.equal(messages.every(m=>m.source==='simulated'),true);
});
test('same stage and daily digest have stable dedupe keys; new stages get new keys', () => {
  assert.equal(nudge().dedupeKey,plan([journey()],'2026-10-29T17:00:00Z').messages.find(m=>m.kind==='investor_nudge').dedupeKey);
  const changed=plan([journey({status:'documents',stageEnteredAt:'2026-10-26T18:00:00Z'})]).messages.find(m=>m.kind==='investor_nudge');
  assert.notEqual(nudge().dedupeKey,changed.dedupeKey);
  const first=enqueueMockNotifications({},plan().messages);
  assert.equal(Object.keys(enqueueMockNotifications(first,plan().messages)).length,2);
});
test('mock success and old attempt replay cannot send or count twice', () => {
  const message=nudge();let outbox=enqueueMockNotifications({},[message]);
  outbox=deliver(outbox,message.dedupeKey,'attempt-1');
  assert.equal(outbox[message.dedupeKey].status,'sent');
  assert.equal(outbox[message.dedupeKey].attempts,1);
  const replay=deliver(outbox,message.dedupeKey,'attempt-1');
  assert.deepEqual(replay,outbox);
  assert.equal(outbox[message.dedupeKey].receiptId,'mock:attempt-1');
});
test('mock delivery rechecks journey ownership/stage and terminal state', () => {
  const message=nudge();const queued=enqueueMockNotifications({},[message]);
  for(const changed of [{status:'funded'},{status:'withdrawn'},{nextActionOwner:'gp'},{status:'documents'}]) {
    const result=deliver(queued,message.dedupeKey,'stale','success',[journey(changed)]);
    assert.equal(result[message.dedupeKey].status,'cancelled');
    assert.equal(result[message.dedupeKey].attempts,0);
  }
  assert.equal(queued[message.dedupeKey].status,'pending');
});
test('digest refresh drops finished investments before mock delivery', () => {
  const message=plan().messages.find(m=>m.kind==='gp_digest');const queued=enqueueMockNotifications({},[message]);
  assert.equal(deliver(queued,message.dedupeKey,'digest','success',[journey({status:'funded'})])[message.dedupeKey].status,'cancelled');
});
test('temporary failures are visible and retries are bounded and replay-safe', () => {
  const message=nudge();let outbox=enqueueMockNotifications({},[message]);
  outbox=deliver(outbox,message.dedupeKey,'attempt-1','temporary_failure');
  assert.equal(outbox[message.dedupeKey].status,'failed');
  outbox=deliver(outbox,message.dedupeKey,'attempt-2','temporary_failure');
  assert.equal(outbox[message.dedupeKey].attempts,2);
  assert.deepEqual(deliver(outbox,message.dedupeKey,'attempt-1','success'),outbox);
  const exhausted=deliver(outbox,message.dedupeKey,'attempt-3','success');
  assert.equal(exhausted[message.dedupeKey].status,'failed');
  assert.equal(exhausted[message.dedupeKey].attempts,2);
  assert.equal(exhausted[message.dedupeKey].lastError,'retry_limit');
});
test('bounces remain visible and suppress later mock messages to same recipient', () => {
  const message=nudge();let outbox=enqueueMockNotifications({},[message]);
  outbox=deliver(outbox,message.dedupeKey,'bounce','bounce');
  assert.equal(outbox[message.dedupeKey].status,'bounced');
  const later=plan([journey()],'2026-11-04T18:00:00Z').messages.find(m=>m.kind==='investor_nudge');
  outbox=enqueueMockNotifications(outbox,[later]);
  assert.equal(outbox[later.dedupeKey].status,'cancelled');
  assert.equal(outbox[later.dedupeKey].lastError,'recipient_bounced');
});
test('mock delivery rechecks timing approval and never silently sends outside window', () => {
  const message=nudge();const queued=enqueueMockNotifications({},[message]);
  const result=deliver(queued,message.dedupeKey,'not-approved','success',[journey()],now,{...policy,approved:false});
  assert.equal(result[message.dedupeKey].status,'pending');
  assert.equal(result[message.dedupeKey].attempts,0);
  assert.equal(result[message.dedupeKey].lastError,'timing_not_approved');
});

test('queued nudge is cancelled when its configured threshold is withdrawn', () => {
  const message=nudge(), queued=enqueueMockNotifications({},[message]);
  const updated=deliver(queued,message.dedupeKey,'policy-change','success',[journey()],now,{...policy,nudgeBusinessDays:[5]});
  assert.equal(updated[message.dedupeKey].status,'cancelled');
  assert.equal(updated[message.dedupeKey].lastError,'timing_policy_changed');
  assert.equal(updated[message.dedupeKey].attempts,0);
});
test('digest refresh uses the current stage timestamp and business age', () => {
  const message=plan().messages.find(m=>m.kind==='gp_digest'), queued=enqueueMockNotifications({},[message]);
  const updated=deliver(queued,message.dedupeKey,'refresh','success',[journey({status:'documents',stageEnteredAt:'2026-10-28T16:00:00Z',nextActionOwner:'gp'})]);
  const entry=updated[message.dedupeKey].message.entries[0];
  assert.equal(entry.status,'documents');
  assert.equal(entry.nextActionOwner,'gp');
  assert.equal(entry.stageEnteredAt,'2026-10-28T16:00:00.000Z');
  assert.equal(entry.businessDays,0);
});
test('mock outbox rejects live source markers and conflicting planning snapshots', () => {
  assert.throws(()=>enqueueMockNotifications({},[{...nudge(),source:'production'}]),/simulated/);
  assert.throws(()=>plan([journey(),journey({nextActionOwner:'gp'})]),/Conflicting/);
});

test('conflicting delivery snapshots cannot let an older investor-owned state win', () => {
  const message=nudge(), queued=enqueueMockNotifications({},[message]);
  assert.throws(()=>deliver(queued,message.dedupeKey,'conflicting','success',[journey(),journey({status:'funded'})]),/Conflicting/);
  assert.equal(queued[message.dedupeKey].status,'pending');
  const exactDuplicates=deliver(queued,message.dedupeKey,'duplicates','success',[journey(),journey()]);
  assert.equal(exactDuplicates[message.dedupeKey].attempts,1);
});

test('digest delivery includes newly unfinished journeys from its refreshed authorized snapshot', () => {
  const message=plan().messages.find(m=>m.kind==='gp_digest'), queued=enqueueMockNotifications({},[message]);
  const second={snapshot:{...journey().snapshot,scope:{subscriptionId:'sub-2',entityId:'entity-2',dealId:'deal-1'}},recipientId:'lp-2'};
  const updated=deliver(queued,message.dedupeKey,'new-journey','success',[journey(),second]);
  assert.equal(updated[message.dedupeKey].message.entries.length,2);
  assert.match(updated[message.dedupeKey].message.body,/2 unfinished/);
});
