import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { toCsv } from "@/lib/distributions";

// CSV for your bank's batch ACH upload. Bank details stay at the bank — map
// payee names to saved payees there.
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: isGp } = await supabase.rpc("is_gp");
  if (!isGp) return new NextResponse("Forbidden", { status: 403 });

  const { data: dist, error } = await supabase
    .from("distributions")
    .select("dist_date, memo, deals(name), distribution_lines(amount, paid_at, subscriptions(funded_amount, investing_entities(legal_name, profiles(email))))")
    .eq("id", id)
    .single();
  if (error || !dist) return new NextResponse("Not found", { status: 404 });

  type Line = {
    amount: number;
    paid_at: string | null;
    subscriptions: { funded_amount: number; investing_entities: { legal_name: string; profiles: { email: string } } };
  };
  const lines = dist.distribution_lines as unknown as Line[];
  const deal = dist.deals as unknown as { name: string };

  const csv = toCsv(
    lines.map((l) => ({
      payee: l.subscriptions.investing_entities.legal_name,
      email: l.subscriptions.investing_entities.profiles.email,
      funded_capital: Number(l.subscriptions.funded_amount).toFixed(2),
      amount: Number(l.amount).toFixed(2),
      date: dist.dist_date,
      memo: dist.memo ?? deal.name,
      paid: l.paid_at ? "yes" : "no",
    })),
  );

  return new NextResponse(csv, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="distribution-${dist.dist_date}.csv"`,
    },
  });
}
