import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { isAccreditationValid, METHOD_LABEL, type AccredMethod } from "@/lib/accreditation";
import { Badge, Flash } from "@/app/components/Topbar";
import { ENTITY_LABEL, STATUS_LABEL, date, usd } from "@/lib/util";

type SP = Promise<Record<string, string | undefined>>;

export default async function Portfolio({ searchParams }: { searchParams: SP }) {
  const sp = await searchParams;
  const { supabase } = await requireUser();

  const [{ data: entities }, { data: subs }, { data: deals }, { data: lines }, { data: docs }, { data: accs }] =
    await Promise.all([
      supabase.from("investing_entities").select("*").order("created_at"),
      supabase
        .from("subscriptions")
        .select("*, deals(name), investing_entities(legal_name)")
        .order("created_at", { ascending: false }),
      supabase.from("deals").select("*").eq("status", "open").order("created_at", { ascending: false }),
      supabase
        .from("distribution_lines")
        .select("amount, paid_at, distributions(dist_date, memo, deals(name))")
        .order("id"),
      supabase.from("documents").select("*, deals(name)").order("created_at", { ascending: false }),
      supabase.from("accreditations").select("*").order("created_at", { ascending: false }),
    ]);

  const active = (subs ?? []).filter((s) => !["withdrawn", "rejected"].includes(s.status));
  const funded = active.filter((s) => s.status === "funded");
  const invested = funded.reduce((sum, s) => sum + Number(s.funded_amount ?? s.amount), 0);
  const distributed = (lines ?? []).reduce((sum, l) => sum + Number(l.amount), 0);

  return (
    <>
      <Flash searchParams={sp} />
      <h1>Your portfolio</h1>

      <div className="kpis">
        <div className="kpi"><div className="label">Invested</div><div className="value">{usd(invested)}</div></div>
        <div className="kpi"><div className="label">Distributions received</div><div className="value">{usd(distributed)}</div></div>
        <div className="kpi"><div className="label">Active investments</div><div className="value">{funded.length}</div></div>
      </div>

      {(deals ?? []).length > 0 && (
        <section className="card">
          <h2>Open offerings</h2>
          <div className="table-wrap">
            <table>
              <thead><tr><th>Offering</th><th className="num">Minimum</th><th /></tr></thead>
              <tbody>
                {deals!.map((d) => (
                  <tr key={d.id}>
                    <td>{d.name}</td>
                    <td className="num">{usd(d.min_investment)}</td>
                    <td className="num"><Link className="btn" href={`/portal/deals/${d.id}`}>View</Link></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      <section className="card">
        <h2>Your investments</h2>
        {active.length === 0 ? (
          <p className="muted">No investments yet.</p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead><tr><th>Offering</th><th>Entity</th><th className="num">Amount</th><th>Status</th><th /></tr></thead>
              <tbody>
                {active.map((s) => (
                  <tr key={s.id}>
                    <td>{s.deals?.name}</td>
                    <td>{s.investing_entities?.legal_name}</td>
                    <td className="num">{usd(s.funded_amount ?? s.amount)}</td>
                    <td><Badge value={s.status} label={STATUS_LABEL[s.status]} /></td>
                    <td className="num"><Link href={`/portal/deals/${s.deal_id}`}>Open</Link></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <div className="grid">
        <section className="card">
          <div className="spread">
            <h2>Investing entities</h2>
            <Link href="/portal/entities/new" className="small">+ Add</Link>
          </div>
          {(entities ?? []).length === 0 && <p className="muted">Add the person or entity you'll invest through.</p>}
          {(entities ?? []).map((e) => {
            const acc = (accs ?? []).find((a) => a.entity_id === e.id && a.status !== "rejected");
            const valid = isAccreditationValid(acc);
            return (
              <div key={e.id} className="spread" style={{ padding: "8px 0", borderBottom: "1px solid var(--line)" }}>
                <div>
                  <div>{e.legal_name}</div>
                  <div className="small muted">{ENTITY_LABEL[e.entity_type]}</div>
                </div>
                <div className="small" style={{ textAlign: "right" }}>
                  {!acc && <span className="muted">Not verified</span>}
                  {acc && valid && (
                    <>
                      <Badge value="verified" label="Accredited" />
                      <div className="muted">
                        {acc.expires_at ? `through ${date(acc.expires_at)}` : METHOD_LABEL[acc.method as AccredMethod]}
                      </div>
                    </>
                  )}
                  {acc && !valid && acc.status === "pending" && <Badge value="pending" label="Under review" />}
                  {acc && !valid && acc.status === "verified" && <Badge value="rejected" label="Expired" />}
                </div>
              </div>
            );
          })}
        </section>

        <section className="card">
          <h2>Distributions</h2>
          {(lines ?? []).length === 0 ? (
            <p className="muted">None yet.</p>
          ) : (
            <table>
              <tbody>
                {lines!.map((l, i) => {
                  const d = l.distributions as unknown as { dist_date: string; memo: string | null; deals: { name: string } };
                  return (
                    <tr key={i}>
                      <td>{date(d?.dist_date)}<div className="small muted">{d?.deals?.name}</div></td>
                      <td className="num">{usd(l.amount, 2)}<div className="small muted">{l.paid_at ? "Paid" : "Scheduled"}</div></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </section>
      </div>

      <section className="card">
        <h2>Documents</h2>
        {(docs ?? []).length === 0 ? (
          <p className="muted">Nothing posted yet.</p>
        ) : (
          <table>
            <thead><tr><th>Document</th><th>Offering</th><th>Posted</th></tr></thead>
            <tbody>
              {docs!.map((d) => (
                <tr key={d.id}>
                  <td><a href={`/files?path=${encodeURIComponent(d.file_path)}`}>{d.title}</a> <span className="badge">{d.kind.toUpperCase().replace("_", " ")}</span></td>
                  <td>{d.deals?.name ?? "—"}</td>
                  <td>{date(d.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </>
  );
}
