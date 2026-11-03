"use server";

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

export async function sendMagicLink(form: FormData) {
  const email = String(form.get("email") ?? "").trim().toLowerCase();
  if (!email.includes("@")) redirect("/login?error=Enter+a+valid+email");

  const supabase = await createClient();
  // Invite-only: shouldCreateUser=false means only LPs you've invited can sign in.
  const { error } = await supabase.auth.signInWithOtp({
    email,
    options: {
      shouldCreateUser: false,
      emailRedirectTo: `${process.env.NEXT_PUBLIC_SITE_URL}/auth/confirm`,
    },
  });
  if (error) {
    // Keep provider messages, addresses and credentials out of both logs and URLs.
    console.error('Supabase magic-link request failed', {
      code: error.code ?? 'unknown',
      status: error.status,
    });
  }
  // Same message whether or not the email exists — don't leak the LP list.
  redirect("/login?sent=1");
}

export async function signOut() {
  const supabase = await createClient();
  await supabase.auth.signOut();
  redirect("/login");
}
