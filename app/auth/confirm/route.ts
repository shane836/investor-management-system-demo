import { type EmailOtpType } from "@supabase/supabase-js";
import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";

// Handles magic-link and invite emails. See README → "Email templates".
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  // Render's request URL can use its internal bind address. Redirect only to the
  // configured public site, never to that address or a client-supplied host header.
  const siteUrl = process.env.NEXT_PUBLIC_SITE_URL?.trim();
  if (!siteUrl) {
    console.error('Auth confirmation requires NEXT_PUBLIC_SITE_URL.');
    return NextResponse.json({ error: 'Sign-in is unavailable until the Site URL is configured.' }, { status: 503 });
  }
  const { origin } = new URL(siteUrl);
  const token_hash = searchParams.get("token_hash");
  const type = searchParams.get("type") as EmailOtpType | null;
  const code = searchParams.get("code");
  const supabase = await createClient();

  if (token_hash && type) {
    const { error } = await supabase.auth.verifyOtp({ type, token_hash });
    if (!error) return NextResponse.redirect(`${origin}/`);
  } else if (code) {
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) return NextResponse.redirect(`${origin}/`);
  }
  return NextResponse.redirect(`${origin}/login?error=That+link+is+invalid+or+expired`);
}
