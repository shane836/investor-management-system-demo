// 506(c) accreditation rules. Pure functions — mirrored by DB guards in
// supabase/migrations/0001_init.sql. Confirm thresholds with securities counsel.

export type EntityType = "individual" | "joint" | "llc" | "trust" | "ira" | "other";
export type AccredMethod = "third_party_letter" | "verification_service" | "high_minimum";

/** Rule 506(c)(2)(ii)(C): written confirmation from a CPA/attorney/RIA/BD that
 *  they verified status "within the prior three months". We treat letters as
 *  usable for 90 days from the letter date. */
export const LETTER_VALID_DAYS = 90;

/** SEC staff no-action guidance (Mar 2025): minimum investment of $200k for
 *  natural persons / $1M for entities + written reps can satisfy
 *  "reasonable steps". */
export const HIGH_MIN = { natural: 200_000, entity: 1_000_000 } as const;

export const HIGH_MIN_REPS = [
  {
    key: "accredited",
    text: "I (or the investing entity) am an accredited investor as defined in Rule 501(a) of Regulation D.",
  },
  {
    key: "not_financed",
    text: "No part of my investment is financed by a third party for the specific purpose of making this investment.",
  },
] as const;

export const METHOD_LABEL: Record<AccredMethod, string> = {
  third_party_letter: "Letter from CPA / attorney / RIA / broker-dealer",
  verification_service: "Third-party verification service certificate",
  high_minimum: "High minimum investment + written representations",
};

export function highMinimumThreshold(type: EntityType): number {
  return type === "individual" || type === "joint" ? HIGH_MIN.natural : HIGH_MIN.entity;
}

export function highMinimumEligible(type: EntityType, amount: number): boolean {
  return amount >= highMinimumThreshold(type);
}

function toDate(iso: string): Date {
  return new Date(`${iso.slice(0, 10)}T00:00:00Z`);
}

function iso(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function letterExpiry(letterDate: string): string {
  const d = toDate(letterDate);
  d.setUTCDate(d.getUTCDate() + LETTER_VALID_DAYS);
  return iso(d);
}

/** Returns an error message, or null if the letter date is usable today. */
export function checkLetterDate(letterDate: string, today: string = iso(new Date())): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(letterDate)) return "Enter the date on the letter.";
  if (toDate(letterDate) > toDate(today)) return "Letter date can't be in the future.";
  if (letterExpiry(letterDate) < today) return `Letter is older than ${LETTER_VALID_DAYS} days — request a fresh one.`;
  return null;
}

export type AccredLike = { status: string; expires_at: string | null };

export function isAccreditationValid(a: AccredLike | null | undefined, today: string = iso(new Date())): boolean {
  if (!a || a.status !== "verified") return false;
  return a.expires_at === null || a.expires_at >= today;
}
