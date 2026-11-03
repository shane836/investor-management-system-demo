"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import {
  HIGH_MIN_REPS,
  checkLetterDate,
  highMinimumEligible,
  highMinimumThreshold,
  type AccredMethod,
  type EntityType,
} from "@/lib/accreditation";
import { checkUpload, fileFrom, safeName, usd } from "@/lib/util";

const fail = (to: string, msg: string): never => redirect(`${to}?error=${encodeURIComponent(msg)}`);
const done = (to: string, msg: string): never => {
  revalidatePath(to);
  redirect(`${to}?ok=${encodeURIComponent(msg)}`);
};

// ─── Investing entities ───────────────────────────────────────────────────
export async function createEntity(form: FormData) {
  const { supabase, user } = await requireUser();
  const legal_name = String(form.get("legal_name") ?? "").trim();
  const entity_type = String(form.get("entity_type") ?? "");
  const state = String(form.get("state") ?? "").trim() || null;
  const next = String(form.get("next") ?? "/portal");
  if (!legal_name) fail("/portal/entities/new", "Legal name is required.");

  const { error } = await supabase
    .from("investing_entities")
    .insert({ owner_id: user.id, legal_name, entity_type, state });
  if (error) fail("/portal/entities/new", error.message);
  done(next, "Investing entity added.");
}

// ─── Step 1: commit ───────────────────────────────────────────────────────
export async function createSubscription(form: FormData) {
  const { supabase } = await requireUser();
  const deal_id = String(form.get("deal_id"));
  const entity_id = String(form.get("entity_id") ?? "");
  const amount = Number(String(form.get("amount") ?? "").replace(/[$,]/g, ""));
  const back = `/portal/deals/${deal_id}`;

  const { data: deal } = await supabase.from("deals").select("min_investment,status").eq("id", deal_id).single();
  if (!deal || deal.status !== "open") fail(back, "This offering isn't open.");
  if (!entity_id) fail(back, "Pick an investing entity.");
  if (!(amount > 0)) fail(back, "Enter a commitment amount.");
  if (amount < Number(deal!.min_investment)) fail(back, `Minimum investment is ${usd(deal!.min_investment)}.`);

  const { error } = await supabase.from("subscriptions").insert({ deal_id, entity_id, amount });
  if (error) fail(back, error.message.includes("duplicate") ? "That entity already has a subscription in this deal." : error.message);
  done(back, "Commitment recorded. Next: verify accreditation.");
}

// ─── Step 2a: reuse an accreditation that's already verified & current ────
export async function useExistingAccreditation(form: FormData) {
  const { supabase } = await requireUser();
  const sub_id = String(form.get("sub_id"));
  const accreditation_id = String(form.get("accreditation_id"));
  const deal_id = String(form.get("deal_id"));
  const back = `/portal/deals/${deal_id}`;

  // DB trigger re-checks validity, entity match, expiry and high-min threshold.
  const { error } = await supabase
    .from("subscriptions")
    .update({ accreditation_id, status: "documents" })
    .eq("id", sub_id);
  if (error) fail(back, error.message);
  done(back, "Accreditation applied. Next: sign subscription documents.");
}

// ─── Step 2b: submit new accreditation for GP review ──────────────────────
export async function submitAccreditation(form: FormData) {
  const { supabase, user } = await requireUser();
  const sub_id = String(form.get("sub_id"));
  const deal_id = String(form.get("deal_id"));
  const method = String(form.get("method") ?? "") as AccredMethod;
  const back = `/portal/deals/${deal_id}`;

  const { data: sub } = await supabase
    .from("subscriptions")
    .select("id, amount, status, entity_id, investing_entities(entity_type)")
    .eq("id", sub_id)
    .single();
  if (!sub || sub.status !== "committed") fail(back, "Subscription isn't awaiting accreditation.");

  // Supabase types the embedded row loosely; normalize object-or-array.
  const ent = sub!.investing_entities as unknown as { entity_type: EntityType } | { entity_type: EntityType }[];
  const entityType = (Array.isArray(ent) ? ent[0] : ent).entity_type;

  const row: Record<string, unknown> = { entity_id: sub!.entity_id, method, status: "pending" };

  if (method === "high_minimum") {
    if (!highMinimumEligible(entityType, Number(sub!.amount))) {
      fail(back, `High-minimum path requires at least ${usd(highMinimumThreshold(entityType))} for this entity type.`);
    }
    const reps: Record<string, boolean> = {};
    for (const r of HIGH_MIN_REPS) {
      if (form.get(`rep_${r.key}`) !== "on") fail(back, "Please confirm every representation.");
      reps[r.key] = true;
    }
    row.reps = { ...reps, signed_by: user.email, signed_at: new Date().toISOString(), amount: Number(sub!.amount) };
  } else if (method === "third_party_letter" || method === "verification_service") {
    const letter_date = String(form.get("letter_date") ?? "");
    const dateErr = checkLetterDate(letter_date);
    if (dateErr) fail(back, dateErr);

    const file = fileFrom(form, "file");
    if (!file) fail(back, "Attach the verification letter.");
    const upErr = checkUpload(file!);
    if (upErr) fail(back, upErr);

    const path = `${user.id}/${sub!.entity_id}/accreditation/${safeName(file!.name)}`;
    const { error: storageErr } = await supabase.storage
      .from("portal")
      .upload(path, file!, { contentType: file!.type });
    if (storageErr) fail(back, `Upload failed: ${storageErr.message}`);

    Object.assign(row, {
      letter_date,
      file_path: path,
      verifier_name: String(form.get("verifier_name") ?? "").trim() || null,
      verifier_type: method === "verification_service" ? "service" : String(form.get("verifier_type") ?? ""),
    });
  } else {
    fail(back, "Choose a verification method.");
  }

  const { data: acc, error } = await supabase.from("accreditations").insert(row).select("id").single();
  if (error || !acc) fail(back, error?.message ?? "Could not save accreditation.");

  const { error: subErr } = await supabase
    .from("subscriptions")
    .update({ accreditation_id: acc!.id, status: "accreditation" })
    .eq("id", sub_id);
  if (subErr) fail(back, subErr.message);

  done(back, "Submitted. We'll review your accreditation, usually within 1 business day.");
}

// ─── Step 3: upload signed subscription docs ──────────────────────────────
export async function uploadSignedSubscription(form: FormData) {
  const { supabase, user } = await requireUser();
  const sub_id = String(form.get("sub_id"));
  const deal_id = String(form.get("deal_id"));
  const back = `/portal/deals/${deal_id}`;

  const { data: sub } = await supabase.from("subscriptions").select("entity_id,status").eq("id", sub_id).single();
  if (!sub || sub.status !== "documents") fail(back, "Subscription isn't at the documents step.");

  const file = fileFrom(form, "file");
  if (!file) fail(back, "Attach your signed subscription agreement.");
  const upErr = checkUpload(file!);
  if (upErr) fail(back, upErr);

  const path = `${user.id}/${sub!.entity_id}/subscription/${safeName(file!.name)}`;
  const { error: storageErr } = await supabase.storage.from("portal").upload(path, file!, { contentType: file!.type });
  if (storageErr) fail(back, `Upload failed: ${storageErr.message}`);

  const { error } = await supabase.from("subscriptions").update({ signed_doc_path: path }).eq("id", sub_id);
  if (error) fail(back, error.message);
  done(back, "Signed documents received. We'll countersign and send wire instructions here.");
}

export async function withdrawSubscription(form: FormData) {
  const { supabase } = await requireUser();
  const sub_id = String(form.get("sub_id"));
  const deal_id = String(form.get("deal_id"));
  const back = `/portal/deals/${deal_id}`;
  const { error } = await supabase.from("subscriptions").update({ status: "withdrawn" }).eq("id", sub_id);
  if (error) fail(back, error.message);
  done("/portal", "Subscription withdrawn.");
}
