import { isTerminalJourney, sameJourneyScope } from "../journey-contract.ts";
import type { JourneyScope, JourneySnapshot, NextActionOwner, SubscriptionStatus } from "../journey-contract.ts";

// Internal planning contract only. These functions have no network or live transport.
export type NotificationJourney = { snapshot: JourneySnapshot; recipientId: string };
export type NotificationPolicy = { approved: false } | {
  approved: true;
  timeZone: "America/Los_Angeles";
  sendWindow: { startHour: number; endHour: number };
  nudgeBusinessDays: readonly number[];
  // Explicitly supplied by the operator; this module invents no holiday calendar.
  excludedLocalDates: readonly string[];
};
export const DEFAULT_NOTIFICATION_POLICY: NotificationPolicy = { approved: false };

type DigestEntry = {
  scope: JourneyScope; status: SubscriptionStatus; nextActionOwner: NextActionOwner;
  stageEnteredAt: string; businessDays: number;
};
type MessageBase = {
  source: "simulated"; dedupeKey: string; recipientId: string; subject: string; body: string;
};
export type MockNotification = MessageBase & ({
  kind: "investor_nudge"; scope: JourneyScope; stage: SubscriptionStatus; stageEnteredAt: string;
  businessDays: number; thresholdBusinessDays: number; portalPath: string;
} | { kind: "gp_digest"; localDate: string; entries: DigestEntry[] });
export type MockOutboxRecord = {
  message: MockNotification;
  status: "pending" | "failed" | "sent" | "bounced" | "cancelled";
  attempts: number; attemptIds: string[]; lastError?: string; receiptId?: string;
};
export type MockOutbox = Record<string, MockOutboxRecord>;

const statuses = new Set(["committed", "accreditation", "documents", "funding", "funded", "withdrawn", "rejected"]);
const owners = new Set(["investor", "gp", "provider", "none"]);
function identifier(value: string): string {
  if (typeof value !== "string" || !/^[a-zA-Z0-9_-]{1,160}$/.test(value)) throw new Error("Invalid internal recipient/scope identifier");
  return value;
}
function scopeCopy(scope: JourneyScope): JourneyScope {
  return { subscriptionId: identifier(scope.subscriptionId), entityId: identifier(scope.entityId), dealId: identifier(scope.dealId) };
}
function timestamp(value: string): number {
  const result = Date.parse(value);
  if (!Number.isFinite(result) || !/(?:Z|[+-]\d{2}:\d{2})$/i.test(value)) throw new Error("An explicit timestamp with timezone is required");
  return result;
}
function normalize(journey: NotificationJourney, now: number): NotificationJourney {
  const s = journey.snapshot;
  if (!statuses.has(s.status) || !owners.has(s.nextActionOwner)) throw new Error("Unknown journey state/action owner");
  const entered = timestamp(s.stageEnteredAt);
  if (entered > now) throw new Error("Journey stage cannot begin in the future");
  return { recipientId: identifier(journey.recipientId), snapshot: {
    scope: scopeCopy(s.scope), status: s.status, nextActionOwner: s.nextActionOwner,
    stageEnteredAt: new Date(entered).toISOString(),
  } };
}
function localTime(at: number) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", hourCycle: "h23",
  }).formatToParts(at);
  const part = (type: string) => parts.find(p => p.type === type)!.value;
  const date = `${part("year")}-${part("month")}-${part("day")}`;
  return { date, hour: Number(part("hour")), day: new Date(`${date}T00:00:00Z`).getUTCDay() };
}
function approvedPolicy(policy: NotificationPolicy): asserts policy is Extract<NotificationPolicy, { approved: true }> {
  if (!policy.approved) throw new Error("Timing policy is not approved");
  const { startHour, endHour } = policy.sendWindow ?? {};
  if (policy.timeZone !== "America/Los_Angeles" || !Number.isInteger(startHour) || !Number.isInteger(endHour)
    || startHour < 0 || endHour > 24 || startHour >= endHour) throw new Error("Explicit Pacific send window required");
  if (!Array.isArray(policy.nudgeBusinessDays) || policy.nudgeBusinessDays.some(d => !Number.isInteger(d) || d <= 0)
    || new Set(policy.nudgeBusinessDays).size !== policy.nudgeBusinessDays.length) throw new Error("Explicit positive nudge thresholds required");
  if (!Array.isArray(policy.excludedLocalDates) || policy.excludedLocalDates.some(d => !/^\d{4}-\d{2}-\d{2}$/.test(d)
    || new Date(`${d}T00:00:00Z`).toISOString().slice(0,10) !== d)) throw new Error("Explicit excluded business dates required");
}
function windowReason(now: number, policy: NotificationPolicy): string | null {
  if (!policy.approved) return "timing_not_approved";
  approvedPolicy(policy);
  const local = localTime(now);
  return local.day === 0 || local.day === 6 || policy.excludedLocalDates.includes(local.date)
    || local.hour < policy.sendWindow.startHour || local.hour >= policy.sendWindow.endHour ? "outside_approved_window" : null;
}
function businessDays(start: string, now: number, excluded: readonly string[]): number {
  const from = Date.parse(`${localTime(timestamp(start)).date}T00:00:00Z`);
  const through = Date.parse(`${localTime(now).date}T00:00:00Z`);
  let days = 0;
  for (let d = from + 86400000; d <= through; d += 86400000) {
    const date = new Date(d), weekday = date.getUTCDay();
    if (weekday !== 0 && weekday !== 6 && !excluded.includes(date.toISOString().slice(0,10))) days++;
  }
  return days;
}
function scopeKey(scope: JourneyScope): string {
  return [scope.subscriptionId, scope.entityId, scope.dealId].map(encodeURIComponent).join(":");
}
function uniqueJourneys(raw: readonly NotificationJourney[], now: number): NotificationJourney[] {
  const seen = new Map<string, string>(), result: NotificationJourney[] = [];
  for (const item of raw) {
    const journey = normalize(item, now), key = scopeKey(journey.snapshot.scope);
    const previous = seen.get(key), serialized = JSON.stringify(journey);
    if (previous && previous !== serialized) throw new Error("Conflicting journey snapshots");
    if (previous) continue;
    seen.set(key, serialized); result.push(journey);
  }
  return result;
}
function digest(recipientId: string, localDate: string, entries: DigestEntry[]): MockNotification {
  return { source: "simulated", kind: "gp_digest", recipientId, localDate, entries,
    dedupeKey: `digest:${recipientId}:${localDate}`, subject: "Unfinished investor journeys",
    body: `${entries.length} unfinished investor journey(s). Review stages and next-action owners in the secure sponsor queue.` };
}
function nudge(journey: NotificationJourney, age: number, threshold: number): MockNotification {
  const { snapshot: s, recipientId } = journey;
  return { source: "simulated", kind: "investor_nudge", recipientId,
    scope: scopeCopy(s.scope), stage: s.status, stageEnteredAt: s.stageEnteredAt,
    businessDays: age, thresholdBusinessDays: threshold,
    dedupeKey: `nudge:${scopeKey(s.scope)}:${s.status}:${s.stageEnteredAt}:${threshold}`,
    subject: "Your investment needs attention", body: "Open your secure investor portal to review your next onboarding action.",
    portalPath: `/portal/deals/${encodeURIComponent(s.scope.dealId)}` };
}
export function planNotifications(input: {
  now: string; journeys: readonly NotificationJourney[]; digestRecipientId: string; policy?: NotificationPolicy;
}): { messages: MockNotification[]; suppressed: { subscriptionId?: string; reason: string }[] } {
  const now = timestamp(input.now), policy = input.policy ?? DEFAULT_NOTIFICATION_POLICY;
  const blocked = windowReason(now, policy);
  if (blocked) return { messages: [], suppressed: [{ reason: blocked }] };
  approvedPolicy(policy);
  const recipient = identifier(input.digestRecipientId), messages: MockNotification[] = [];
  const entries: DigestEntry[] = [], suppressed: { subscriptionId?: string; reason: string }[] = [];
  for (const journey of uniqueJourneys(input.journeys, now)) {
    const s = journey.snapshot;
    if (isTerminalJourney(s.status)) { suppressed.push({ subscriptionId: s.scope.subscriptionId, reason: "journey_finished" }); continue; }
    const age = businessDays(s.stageEnteredAt, now, policy.excludedLocalDates);
    entries.push({ scope: scopeCopy(s.scope), status: s.status, nextActionOwner: s.nextActionOwner, stageEnteredAt: s.stageEnteredAt, businessDays: age });
    const threshold = [...policy.nudgeBusinessDays].sort((a,b)=>b-a).find(d => d <= age);
    if (s.nextActionOwner !== "investor") suppressed.push({ subscriptionId:s.scope.subscriptionId,reason:"investor_does_not_own_next_action" });
    else if (threshold === undefined) suppressed.push({ subscriptionId:s.scope.subscriptionId,reason:"nudge_not_due" });
    else messages.push(nudge(journey, age, threshold));
  }
  if (entries.length) messages.push(digest(recipient,localTime(now).date,entries));
  return { messages, suppressed };
}
// Rebuild safe content; never forward arbitrary payload/body fields to a transport.
function safeMessage(message: MockNotification): MockNotification {
  if (message.source !== "simulated") throw new Error("Only simulated notifications are supported");
  if (message.kind === "gp_digest") {
    const entries = message.entries.map(e => ({ scope:scopeCopy(e.scope), status:e.status, nextActionOwner:e.nextActionOwner,
      stageEnteredAt:e.stageEnteredAt, businessDays:e.businessDays }));
    return digest(identifier(message.recipientId),message.localDate,entries);
  }
  if (message.kind !== "investor_nudge") throw new Error("Unknown notification kind");
  return nudge({ recipientId:identifier(message.recipientId), snapshot:{scope:scopeCopy(message.scope),status:message.stage,
    stageEnteredAt:message.stageEnteredAt,nextActionOwner:"investor"}},message.businessDays,message.thresholdBusinessDays);
}
export function enqueueMockNotifications(outbox: MockOutbox, messages: readonly MockNotification[]): MockOutbox {
  const result: MockOutbox = structuredClone(outbox);
  for (const raw of messages) {
    const message = safeMessage(raw);
    if (result[message.dedupeKey]) continue;
    const bounced = Object.values(result).some(r => r.status === "bounced" && r.message.recipientId === message.recipientId);
    result[message.dedupeKey] = { message, status:bounced?"cancelled":"pending",attempts:0,attemptIds:[],
      ...(bounced?{lastError:"recipient_bounced"}:{}) };
  }
  return result;
}
export function deliverMockNotification(outbox: MockOutbox, input: {
  dedupeKey: string; attemptId: string; outcome: "success" | "temporary_failure" | "bounce";
  currentJourneys: readonly NotificationJourney[]; now: string; policy?: NotificationPolicy; maxAttempts: number;
}): MockOutbox {
  const result: MockOutbox = structuredClone(outbox), record = result[input.dedupeKey];
  if (!record) throw new Error("Unknown mock outbox message");
  if (record.status === "sent" || record.status === "bounced" || record.status === "cancelled" || record.attemptIds.includes(input.attemptId)) return result;
  if (!Number.isInteger(input.maxAttempts) || input.maxAttempts < 1 || input.maxAttempts > 10) throw new Error("Explicit bounded retry limit required");
  identifier(input.attemptId);
  if (!["success","temporary_failure","bounce"].includes(input.outcome)) throw new Error("Unknown simulated outcome");
  const now = timestamp(input.now), policy = input.policy ?? DEFAULT_NOTIFICATION_POLICY;
  if (policy.approved) approvedPolicy(policy);
  const current = uniqueJourneys(input.currentJourneys,now);
  const message = safeMessage(record.message);
  record.message = message;
  if (message.kind === "investor_nudge") {
    const journey = current.find(j=>sameJourneyScope(j.snapshot.scope,message.scope));
    if (!journey || journey.recipientId !== message.recipientId || isTerminalJourney(journey.snapshot.status)
      || journey.snapshot.nextActionOwner !== "investor" || journey.snapshot.status !== message.stage
      || journey.snapshot.stageEnteredAt !== message.stageEnteredAt) {
      record.status="cancelled";record.lastError="journey_changed";return result;
    }
  } else {
    // The caller supplies the current authorized GP snapshot, including journeys
    // started since enqueue. Refresh the whole digest instead of its old members.
    const entries = current.filter(journey=>!isTerminalJourney(journey.snapshot.status)).map(journey=>({
      scope: scopeCopy(journey.snapshot.scope), status: journey.snapshot.status,
      nextActionOwner: journey.snapshot.nextActionOwner, stageEnteredAt: journey.snapshot.stageEnteredAt,
      businessDays: policy.approved ? businessDays(journey.snapshot.stageEnteredAt,now,policy.excludedLocalDates) : 0,
    }));
    if (!entries.length) { record.status="cancelled";record.lastError="no_unfinished_journeys";return result; }
    record.message=digest(message.recipientId,message.localDate,entries);
  }
  if (Object.values(result).some(r=>r.status==="bounced" && r.message.recipientId===message.recipientId)) {
    record.status="cancelled";record.lastError="recipient_bounced";return result;
  }
  const blocked=windowReason(now,policy);
  if(blocked) {record.lastError=blocked;return result;}
  approvedPolicy(policy);
  if(message.kind === "investor_nudge" && (!policy.nudgeBusinessDays.includes(message.thresholdBusinessDays)
    || businessDays(message.stageEnteredAt,now,policy.excludedLocalDates) < message.thresholdBusinessDays)) {
    record.status="cancelled";record.lastError="timing_policy_changed";return result;
  }
  // A queued digest may not leak into a later day's delivery after timing changes.
  if(message.kind==="gp_digest" && message.localDate!==localTime(now).date) {
    record.status="cancelled";record.lastError="digest_date_changed";return result;
  }
  if(record.attempts>=input.maxAttempts) {record.lastError="retry_limit";return result;}
  record.attempts++;record.attemptIds.push(input.attemptId);
  if(input.outcome==="success") {record.status="sent";record.receiptId=`mock:${input.attemptId}`;delete record.lastError;}
  else {record.status=input.outcome==="bounce"?"bounced":"failed";record.lastError=input.outcome;}
  return result;
}
