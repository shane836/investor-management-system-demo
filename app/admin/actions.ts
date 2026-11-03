"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireGP } from "@/lib/auth";
import { createServiceClient } from "@/lib/supabase/server";
import { letterExpiry } from "@/lib/accreditation";
import { proRata } from "@/lib/distributions";
import { checkUpload, fileFrom, safeName } from "@/lib/util";

const fail = (to: string, msg: string): never => redirect(`${to}?error=${encodeURIComponent(msg)}`);
const done = (to: string, msg: string): never => {
  revalidatePath(to);
  redirect(`${to}?ok=${encodeURIComponent(msg)}`);
};
const num = (v: FormDataEntryValue | null) => Number(String(v ?? "").replace(/[$,]/g, ""));

// ─── Investors ────────────────────────────────────────────────────────────
export async function inviteInvestor(form: FormData) {
  await requireGP();
  const email = String(form.get("email") ?? "").trim().toLowerCase();
  const full_name = String(form.get("full_name") ?? "").trim();
  if (!email.includes("@")) fail("/admin", "Enter a valid email.");

  const admin = createServiceClient();
  const { error } = await admin.auth.admin.inviteUserByEmail(email, {
    data: { full_name },
    redirectTo: `${process.env.NEXT_PUBLIC_SITE_URL}/auth/confirm`,
  });
  if (error) fail("/admin", error.message);
  done("/admin", `Invite sent to ${email}.`);
}

// ─── Deals ────────────────────────────────────────────────────────────────
export async function createDeal(form: FormData) {
  const { supabase } = await requireGP();
  const name = String(form.get("name") ?? "").trim();
  if (!name) fail("/admin", "Deal name is required.");

  const { data, error } = await supabase
    .from("deals")
    .insert({
      name,
      status: "draft",
      target_raise: num(form.get("target_raise")) || null,
      min_investment: num(form.get("min_investment")) || 0,
      max_investors: num(form.get("max_investors")) || 25,
    })
    .select("id")
    .single();
  if (error || !data) fail("/admin", error?.message ?? "Could not create deal.");

  await supabase.from("deal_private").insert({ deal_id: data!.id, wire_instructions: null });
  done(`/admin/deals/${data!.id}`, "Deal created as draft. Add documents and wire instructions, then open it.");
}

export async function updateDeal(form: FormData) {
  const { supabase } = await requireGP();
  const id = String(form.get("deal_id"));
  const back = `/admin/deals/${id}`;
  const { error } = await supabase
    .from("deals")
    .update({
      status: String(form.get("status")),
      min_investment: num(form.get("min_investment")) || 0,
      target_raise: num(form.get("target_raise")) || null,
      max_investors: num(form.get("max_investors")) || 25,
    })
    .eq("id", id);
  if (error) fail(back, error.message);

  const wire = String(form.get("wire_instructions") ?? "").trim() || null;
  const { error: wErr } = await supabase.from("deal_private").upsert({ deal_id: id, wire_instructions: wire });
  if (wErr) fail(back, wErr.message);
  done(back, "Deal updated.");
}

// ─── Per-investment minimum exceptions ────────────────────────────────────
export async function approveMinimumException(form: FormData) {
  const { supabase } = await requireGP();
  const deal_id = String(form.get("deal_id") ?? "");
  const entity_id = String(form.get("entity_id") ?? "");
  const amount = num(form.get("amount"));
  const reason = String(form.get("reason") ?? "").trim();
  const back = `/admin/deals/${deal_id}`;
  if (!entity_id || !Number.isFinite(amount) || amount <= 0 || !reason)
    fail(back, "Choose an entity, enter a positive amount and explain the exception.");
  const { error } = await supabase.rpc("set_subscription_minimum_exception", {
    p_deal_id: deal_id, p_entity_id: entity_id, p_amount: amount, p_reason: reason,
  });
  if (error) fail(back, error.message);
  revalidatePath(`/portal/deals/${deal_id}`);
  done(back, "Investment amount approved. Accreditation and signing are still required.");
}

export async function revokeMinimumException(form: FormData) {
  const { supabase } = await requireGP();
  const deal_id = String(form.get("deal_id") ?? "");
  const back = `/admin/deals/${deal_id}`;
  const reason = String(form.get("reason") ?? "").trim();
  if (!reason) fail(back, "Explain why the exception is being revoked.");
  const { error } = await supabase.rpc("revoke_subscription_minimum_exception", {
    p_subscription_id: String(form.get("sub_id") ?? ""), p_reason: reason,
  });
  if (error) fail(back, error.message);
  revalidatePath(`/portal/deals/${deal_id}`);
  done(back, "Exception revoked and unfunded commitment withdrawn. History retained.");
}

// ─── Internal journey exceptions ──────────────────────────────────────────
export async function openJourneyException(form: FormData) {
  const { supabase } = await requireGP();
  const { error } = await supabase.rpc("open_journey_exception", {
    p_subscription_id: String(form.get("sub_id") ?? ""),
    p_kind: String(form.get("kind") ?? ""),
    p_summary: String(form.get("summary") ?? "").trim(),
    p_owner_id: String(form.get("owner_id") ?? "") || null,
  });
  if (error) fail("/admin/exceptions", error.message);
  done("/admin/exceptions", "Exception recorded, or the existing open exception retained.");
}

export async function updateJourneyException(form: FormData) {
  const { supabase } = await requireGP();
  const decision = String(form.get("decision") ?? "");
  if (!["save", "resolve"].includes(decision)) fail("/admin/exceptions", "Choose Save or Resolve.");
  const version = Number(form.get("version"));
  if (!Number.isSafeInteger(version) || version < 1) fail("/admin/exceptions", "Refresh this exception before saving.");
  const { error } = await supabase.rpc("update_journey_exception", {
    p_exception_id: String(form.get("exception_id") ?? ""),
    p_expected_version: version,
    p_owner_id: String(form.get("owner_id") ?? ""),
    p_summary: String(form.get("summary") ?? "").trim(),
    p_status: decision === "resolve" ? "resolved" : "open",
    p_resolution: String(form.get("resolution") ?? "").trim() || null,
  });
  if (error) fail("/admin/exceptions", error.message);
  done("/admin/exceptions", decision === "resolve" ? "Exception resolved; investment approvals are unchanged." : "Exception owner/details saved.");
}

// ─── Accreditation review ─────────────────────────────────────────────────
export async function reviewAccreditation(form: FormData) {
  const { supabase, user } = await requireGP();
  const id = String(form.get("accreditation_id"));
  const decision = String(form.get("decision"));
  const notes = String(form.get("notes") ?? "").trim() || null;

  const { data: acc } = await supabase.from("accreditations").select("*").eq("id", id).single();
  if (!acc || acc.status !== "pending") fail("/admin", "Already reviewed.");

  if (decision === "verified") {
    // Letters/certificates: usable 90 days from letter date. High-min: tied to the subscription amount (no expiry).
    const expires_at = acc!.letter_date ? letterExpiry(acc!.letter_date) : null;
    const { error } = await supabase
      .from("accreditations")
      .update({ status: "verified", reviewed_by: user.id, reviewed_at: new Date().toISOString(), expires_at, notes })
      .eq("id", id);
    if (error) fail("/admin", error.message);

    const { error: subErr } = await supabase
      .from("subscriptions")
      .update({ status: "documents" })
      .eq("accreditation_id", id)
      .eq("status", "accreditation");
    if (subErr) fail("/admin", subErr.message);
    done("/admin", "Verified. Investor can now sign documents.");
  } else {
    if (!notes) fail("/admin", "Add a note explaining the rejection — the investor will see it.");
    const { error } = await supabase
      .from("accreditations")
      .update({ status: "rejected", reviewed_by: user.id, reviewed_at: new Date().toISOString(), notes })
      .eq("id", id);
    if (error) fail("/admin", error.message);

    await supabase
      .from("subscriptions")
      .update({ status: "committed", accreditation_id: null })
      .eq("accreditation_id", id)
      .eq("status", "accreditation");
    done("/admin", "Rejected. Investor is back at the accreditation step.");
  }
}

// ─── Subscriptions ────────────────────────────────────────────────────────
export async function countersign(form: FormData) {
  const { supabase } = await requireGP();
  const sub_id = String(form.get("sub_id"));
  const back = `/admin/deals/${form.get("deal_id")}`;
  const { error } = await supabase
    .from("subscriptions")
    .update({ status: "funding", gp_countersigned_at: new Date().toISOString() })
    .eq("id", sub_id)
    .eq("status", "documents");
  if (error) fail(back, error.message); // trigger rejects if accreditation expired
  done(back, "Countersigned. Wire instructions are now visible to the investor.");
}

export async function markFunded(form: FormData) {
  const { supabase } = await requireGP();
  const sub_id = String(form.get("sub_id"));
  const back = `/admin/deals/${form.get("deal_id")}`;
  const funded_amount = num(form.get("funded_amount"));
  const funded_at = String(form.get("funded_at") ?? "");
  if (!(funded_amount > 0) || !funded_at) fail(back, "Enter the amount received and the date.");

  const { error } = await supabase
    .from("subscriptions")
    .update({ status: "funded", funded_amount, funded_at })
    .eq("id", sub_id)
    .eq("status", "funding");
  if (error) fail(back, error.message);
  done(back, "Marked funded.");
}

export async function rejectSubscription(form: FormData) {
  const { supabase } = await requireGP();
  const back = `/admin/deals/${form.get("deal_id")}`;
  const { error } = await supabase.from("subscriptions").update({ status: "rejected" }).eq("id", String(form.get("sub_id")));
  if (error) fail(back, error.message);
  done(back, "Subscription declined.");
}

// ─── Documents ────────────────────────────────────────────────────────────
export async function uploadDocument(form: FormData) {
  const { supabase, user } = await requireGP();
  const deal_id = String(form.get("deal_id"));
  const entity_id = String(form.get("entity_id") ?? "") || null;
  const kind = String(form.get("kind"));
  const title = String(form.get("title") ?? "").trim();
  const back = `/admin/deals/${deal_id}`;

  const file = fileFrom(form, "file");
  if (!file) fail(back, "Choose a file.");
  const upErr = checkUpload(file!);
  if (upErr) fail(back, upErr);
  if (kind === "k1" && !entity_id) fail(back, "K-1s must be assigned to an investing entity.");

  let path: string;
  if (entity_id) {
    const { data: ent } = await supabase.from("investing_entities").select("owner_id").eq("id", entity_id).single();
    if (!ent) fail(back, "Unknown entity.");
    path = `${ent!.owner_id}/${entity_id}/${kind}/${safeName(file!.name)}`;
  } else {
    path = `deals/${deal_id}/${kind}/${safeName(file!.name)}`;
  }

  const { error: sErr } = await supabase.storage.from("portal").upload(path, file!, { contentType: file!.type });
  if (sErr) fail(back, sErr.message);

  const { error } = await supabase
    .from("documents")
    .insert({ deal_id, entity_id, kind, title: title || file!.name, file_path: path, uploaded_by: user.id });
  if (error) fail(back, error.message);
  done(back, "Document posted.");
}

// ─── Distributions ────────────────────────────────────────────────────────
export async function createDistribution(form: FormData) {
  const { supabase } = await requireGP();
  const deal_id = String(form.get("deal_id"));
  const back = `/admin/deals/${deal_id}`;
  const total = num(form.get("total"));
  const dist_date = String(form.get("dist_date") ?? "");
  const memo = String(form.get("memo") ?? "").trim() || null;
  if (!(total > 0) || !dist_date) fail(back, "Enter a total and a date.");

  const { data: subs } = await supabase
    .from("subscriptions")
    .select("id, funded_amount, amount")
    .eq("deal_id", deal_id)
    .eq("status", "funded")
    .order("created_at");
  if (!subs?.length) fail(back, "No funded investors yet.");

  const lines = proRata(
    total,
    subs!.map((s) => ({ id: s.id, funded: Number(s.funded_amount ?? s.amount) })),
  );

  const { data: dist, error } = await supabase
    .from("distributions")
    .insert({ deal_id, total, dist_date, memo })
    .select("id")
    .single();
  if (error || !dist) fail(back, error?.message ?? "Could not create distribution.");

  const { error: lErr } = await supabase
    .from("distribution_lines")
    .insert(lines.map((l) => ({ ...l, distribution_id: dist!.id })));
  if (lErr) fail(back, lErr.message);
  done(back, "Distribution created. Export the CSV for your bank's batch payment.");
}

export async function markDistributionPaid(form: FormData) {
  const { supabase } = await requireGP();
  const back = `/admin/deals/${form.get("deal_id")}`;
  const { error } = await supabase
    .from("distribution_lines")
    .update({ paid_at: new Date().toISOString() })
    .eq("distribution_id", String(form.get("distribution_id")))
    .is("paid_at", null);
  if (error) fail(back, error.message);
  done(back, "Marked paid.");
}
