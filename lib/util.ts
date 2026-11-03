export const FIRM = process.env.NEXT_PUBLIC_FIRM_NAME ?? "Sample Investment Partners";
export const IR_EMAIL = process.env.NEXT_PUBLIC_IR_EMAIL ?? "";

export function usd(n: number | string | null | undefined, digits = 0): string {
  const v = typeof n === "string" ? Number(n) : n ?? 0;
  return v.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

export function date(d: string | null | undefined): string {
  if (!d) return "—";
  return new Date(d.length === 10 ? `${d}T00:00:00` : d).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Storage-safe file name. */
export function safeName(name: string): string {
  const clean = name.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(-80);
  return `${Date.now()}-${clean || "file"}`;
}

export function fileFrom(form: FormData, key: string): File | null {
  const f = form.get(key);
  return f instanceof File && f.size > 0 ? f : null;
}

export const MAX_UPLOAD_BYTES = 15 * 1024 * 1024;
export const ALLOWED_UPLOAD = ["application/pdf", "image/png", "image/jpeg"];

export function checkUpload(f: File): string | null {
  if (f.size > MAX_UPLOAD_BYTES) return "File is over 15 MB.";
  if (!ALLOWED_UPLOAD.includes(f.type)) return "Upload a PDF, PNG or JPG.";
  return null;
}

export const STATUS_LABEL: Record<string, string> = {
  committed: "Committed",
  accreditation: "Accreditation under review",
  documents: "Sign documents",
  funding: "Ready to fund",
  funded: "Funded",
  withdrawn: "Withdrawn",
  rejected: "Declined",
};

export const ENTITY_LABEL: Record<string, string> = {
  individual: "Individual",
  joint: "Joint (spouses / JTWROS)",
  llc: "LLC / Corporation",
  trust: "Trust",
  ira: "Self-directed IRA / 401k",
  other: "Other",
};
