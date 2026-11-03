import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";

// /files?path=...  → 60-second signed URL. Storage RLS decides who may read.
export async function GET(request: NextRequest) {
  const path = request.nextUrl.searchParams.get("path");
  if (!path) return new NextResponse("Missing path", { status: 400 });

  const supabase = await createClient();
  const { data, error } = await supabase.storage.from("portal").createSignedUrl(path, 60);
  if (error || !data) return new NextResponse("Not found", { status: 404 });
  return NextResponse.redirect(data.signedUrl);
}
