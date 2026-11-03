// Internal fixture adapter only. No provider API contract, webhook authentication,
// document download, database mutation or production authorization is implemented.
import { sameJourneyScope, type ApprovalGates, type FixtureEventMeta, type JourneyScope, type NextActionOwner } from "../journey-contract.ts";

export type FixtureArtifactReceipt = {
  storagePath: string;
  sha256: string;
  byteLength: number;
  mimeType: "application/pdf";
};
export type VerificationSigningFixtureEvent = FixtureEventMeta & (
  | { kind: "verification.result"; requestId: string; result: "pending" | "passed" | "failed"; evidence?: FixtureArtifactReceipt }
  | { kind: "signing.result"; requestId: string; status: "pending" | "awaiting_gp" | "completed"; signedPdf?: FixtureArtifactReceipt; auditTrail?: FixtureArtifactReceipt }
);
export type FixtureReviewConfig = {
  scope: JourneyScope;
  ownerUserId: string;
  verificationRequestId: string;
  signingRequestId: string;
};
export type FixtureReviewState = {
  source: "simulated";
  config: FixtureReviewConfig;
  seenEvents: Record<string, string>;
  verification: { result: "pending" | "passed" | "failed"; lastOccurredAt: string | null; evidence: FixtureArtifactReceipt | null };
  signing: { status: "pending" | "awaiting_gp" | "completed"; lastOccurredAt: string | null; signedPdf: FixtureArtifactReceipt | null; auditTrail: FixtureArtifactReceipt | null };
  receipts: FixtureArtifactReceipt[];
  history: { eventId: string; kind: VerificationSigningFixtureEvent["kind"]; occurredAt: string }[];
};
export type FixtureReviewResult = {
  state: FixtureReviewState;
  outcome: "applied" | "duplicate" | "stale" | "conflict" | "exception";
  issues: string[];
};
const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const isIdentifier = (value: unknown): value is string => typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(value);
function isScope(value: unknown): value is JourneyScope {
  return isRecord(value) && isIdentifier(value.subscriptionId) && isIdentifier(value.entityId) && isIdentifier(value.dealId);
}
export function createFixtureReviewState(config: FixtureReviewConfig): FixtureReviewState {
  if (!isScope(config.scope) || !isIdentifier(config.ownerUserId) || !isIdentifier(config.verificationRequestId) || !isIdentifier(config.signingRequestId)) {
    throw new Error("Fixture review requires explicit scope, owner and expected provider request IDs");
  }
  return {
    source: "simulated", config: { ...config, scope: { ...config.scope } }, seenEvents: {},
    verification: { result: "pending", lastOccurredAt: null, evidence: null },
    signing: { status: "pending", lastOccurredAt: null, signedPdf: null, auditTrail: null },
    receipts: [], history: [],
  };
}
function receipt(value: unknown, config: FixtureReviewConfig, folder: string): FixtureArtifactReceipt | null {
  if (!isRecord(value) || value.mimeType !== "application/pdf" || typeof value.storagePath !== "string"
      || typeof value.sha256 !== "string" || !/^[a-fA-F0-9]{64}$/.test(value.sha256)
      || typeof value.byteLength !== "number" || !Number.isSafeInteger(value.byteLength) || value.byteLength <= 0) return null;
  const parts = value.storagePath.split("/");
  if (parts.length !== 4 || parts[0] !== config.ownerUserId || parts[1] !== config.scope.entityId
      || parts[2] !== folder || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*\.pdf$/i.test(parts[3])) return null;
  return { storagePath: value.storagePath, sha256: value.sha256.toLowerCase(), byteLength: value.byteLength, mimeType: "application/pdf" };
}
function result(state: FixtureReviewState, outcome: FixtureReviewResult["outcome"], issue?: string): FixtureReviewResult {
  return { state, outcome, issues: issue ? [issue] : [] };
}

/** Validate simulated artifact receipts. Receipts describe fixture storage only;
 * they do not prove actual PDF bytes have been retrieved, hashed or backed up. */
export function applyVerificationSigningFixture(state: FixtureReviewState, input: unknown): FixtureReviewResult {
  if (!isRecord(input) || input.source !== "simulated") return result(state, "exception", "Only explicitly simulated fixture events are accepted");
  if (!isIdentifier(input.eventId) || !isScope(input.scope) || !sameJourneyScope(input.scope, state.config.scope)) {
    return result(state, "exception", "Event identity or investment scope does not match this journey");
  }
  if (typeof input.occurredAt !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/.test(input.occurredAt)
      || !Number.isFinite(Date.parse(input.occurredAt))) return result(state, "exception", "A UTC event timestamp is required");
  const common = { eventId: input.eventId, source: "simulated" as const, occurredAt: input.occurredAt, scope: { ...state.config.scope } };
  let event: VerificationSigningFixtureEvent;
  if (input.kind === "verification.result") {
    if (input.requestId !== state.config.verificationRequestId || !["pending", "passed", "failed"].includes(String(input.result))) {
      return result(state, "exception", "Verification result or expected request does not match");
    }
    const evidence = input.evidence === undefined ? null : receipt(input.evidence, state.config, "accreditation");
    if ((input.evidence !== undefined && !evidence) || (input.result === "passed" && !evidence)) {
      return result(state, "exception", "Successful verification requires a scoped private evidence receipt");
    }
    event = { ...common, kind: input.kind, requestId: input.requestId, result: input.result as "pending" | "passed" | "failed", ...(evidence ? { evidence } : {}) };
  } else if (input.kind === "signing.result") {
    if (input.requestId !== state.config.signingRequestId || !["pending", "awaiting_gp", "completed"].includes(String(input.status))) {
      return result(state, "exception", "Signing result or expected signing request does not match");
    }
    const signedPdf = input.signedPdf === undefined ? null : receipt(input.signedPdf, state.config, "subscription");
    const auditTrail = input.auditTrail === undefined ? null : receipt(input.auditTrail, state.config, "subscription-audit");
    if ((input.signedPdf !== undefined && !signedPdf) || (input.auditTrail !== undefined && !auditTrail)
        || (input.status === "completed" && (!signedPdf || !auditTrail))) {
      return result(state, "exception", "Completed signing requires private final PDF and audit receipts");
    }
    event = { ...common, kind: input.kind, requestId: input.requestId, status: input.status as "pending" | "awaiting_gp" | "completed", ...(signedPdf ? { signedPdf } : {}), ...(auditTrail ? { auditTrail } : {}) };
  } else return result(state, "exception", "Unsupported simulated event kind");

  // Canonical construction above excludes arbitrary payload/approval properties.
  const fingerprint = JSON.stringify(event);
  if (Object.hasOwn(state.seenEvents, event.eventId)) {
    return state.seenEvents[event.eventId] === fingerprint ? result(state, "duplicate")
      : result(state, "conflict", "Event ID was reused with different content");
  }
  const stream = event.kind === "verification.result" ? state.verification : state.signing;
  if (stream.lastOccurredAt) {
    if (Date.parse(event.occurredAt) < Date.parse(stream.lastOccurredAt)) return result(state, "stale", "Older event retained for caller reconciliation; current facts unchanged");
    if (Date.parse(event.occurredAt) === Date.parse(stream.lastOccurredAt)) return result(state, "conflict", "Equal-time events need explicit reconciliation");
  }
  if (event.kind === "verification.result" && state.verification.result !== "pending" && event.result === "pending") {
    return result(state, "exception", "Pending snapshot cannot erase a completed verification result");
  }
  if (event.kind === "signing.result" && state.signing.status === "completed" && event.status !== "completed") {
    return result(state, "exception", "Pending signing snapshot cannot erase completed artifacts");
  }
  const next = structuredClone(state);
  next.seenEvents[event.eventId] = fingerprint;
  next.history.push({ eventId: event.eventId, kind: event.kind, occurredAt: event.occurredAt });
  const receipts = event.kind === "verification.result" ? [event.evidence] : [event.signedPdf, event.auditTrail];
  for (const item of receipts) {
    if (item && !next.receipts.some(existing => existing.storagePath === item.storagePath && existing.sha256 === item.sha256)) next.receipts.push(item);
  }
  if (event.kind === "verification.result") {
    next.verification = { result: event.result, lastOccurredAt: event.occurredAt, evidence: event.evidence ?? null };
  } else {
    next.signing = { status: event.status, lastOccurredAt: event.occurredAt, signedPdf: event.signedPdf ?? null, auditTrail: event.auditTrail ?? null };
  }
  return result(next, "applied");
}

/** Advisory fixture result, never a command granting approval or moving money. */
export function assessFixtureReadiness(state: FixtureReviewState, gates: ApprovalGates): {
  source: "simulated";
  verificationEvidenceReady: boolean;
  signingEvidenceReady: boolean;
  nextActionOwner: NextActionOwner;
  action: "await_verification" | "review_verification" | "await_signing" | "gp_countersign" | "review_funding_readiness";
  fundingAuthorized: false;
} {
  const verificationEvidenceReady = state.verification.result === "passed" && state.verification.evidence !== null;
  const signingEvidenceReady = state.signing.status === "completed" && state.signing.signedPdf !== null && state.signing.auditTrail !== null;
  let action: "await_verification" | "review_verification" | "await_signing" | "gp_countersign" | "review_funding_readiness";
  if (state.verification.result === "pending" && !gates.accreditationApproved) action = "await_verification";
  else if (!gates.accreditationApproved || state.verification.result === "failed") action = "review_verification";
  else if (state.signing.status === "awaiting_gp" || (signingEvidenceReady && !gates.gpCountersigned)) action = "gp_countersign";
  else if (!signingEvidenceReady) action = "await_signing";
  else action = "review_funding_readiness";
  return { source: "simulated", verificationEvidenceReady, signingEvidenceReady, action,
    nextActionOwner: action === "await_verification" || action === "await_signing" ? "provider" : "gp", fundingAuthorized: false };
}
