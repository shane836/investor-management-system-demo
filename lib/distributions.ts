// Simple pro-rata by funded amount. No waterfall/pref — the GP calculates the
// LP pool off-platform and enters the total here.

export type FundedSub = { id: string; funded: number };
export type Line = { subscription_id: string; amount: number };

const cents = (n: number) => Math.round(n * 100);

export function proRata(total: number, subs: FundedSub[]): Line[] {
  const live = subs.filter((s) => s.funded > 0);
  if (live.length === 0) throw new Error("No funded subscriptions to distribute to.");
  const totalC = cents(total);
  const base = live.reduce((sum, s) => sum + cents(s.funded), 0);

  let allocated = 0;
  return live.map((s, i) => {
    const share =
      i === live.length - 1 ? totalC - allocated : Math.floor((totalC * cents(s.funded)) / base);
    allocated += share;
    return { subscription_id: s.id, amount: share / 100 };
  });
}

export function toCsv(rows: Record<string, string | number>[]): string {
  if (rows.length === 0) return "";
  const headers = Object.keys(rows[0]);
  const esc = (v: string | number) => {
    const s = String(v ?? "");
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [headers.join(","), ...rows.map((r) => headers.map((h) => esc(r[h])).join(","))].join("\n");
}
