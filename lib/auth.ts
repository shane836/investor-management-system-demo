import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

export type Profile = {
  id: string;
  email: string;
  full_name: string | null;
  role: "lp" | "gp";
};

export async function requireUser() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: profile, error } = await supabase.from("profiles").select("*").eq("id", user.id).maybeSingle();
  if (error) {
    console.error("Profile lookup failed", { code: error.code });
    redirect("/login?error=profile-unavailable");
  }
  if (!profile) redirect("/login?error=no-profile");

  return { supabase, user, profile: profile as Profile };
}

export async function requireGP() {
  const ctx = await requireUser();
  if (ctx.profile.role !== "gp") redirect("/portal");
  return ctx;
}
