import Link from "next/link";
import { requireGP } from "@/lib/auth";
import { HIGH_MIN_REPS, METHOD_LABEL, type AccredMethod } from "@/lib/accreditation";
import { Badge, Flash } from "@/app/components/Topbar";
import { ENTITY_LABEL, date, usd } from "@/lib/util";
import { createDeal, inviteInvestor, reviewAccreditation } from "./actions";

export default async function Admin({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const { supabase } = await requireGP();

  const [{ data: pending }, { data: lps }, { data: deals }, { data: subs }] = await Promise.all([
    supabase
      .from("accreditations")
      .select("*, investing_entities(legal_name, entity_type, profiles(email, full_name)), subscriptions(amount, deals(name))")
      .eq("status", "pending")
      .order("created_at"),
    supabase.from("profiles").select("*, investing_entities(id, legal_name)").eq("role", "lp").order("created_at"),
    supabase.from("deals").select("*").order("created_at", { ascending: false }),
    supabase.from("subscriptions").select("deal_id, status, amount, funded_amount"),
  ]);

  const live = (subs ?? []).filter((s) => !["withdrawn", "rejected"].includes(s.status));
  const raised = live.filter((s) => s.status === "funded").reduce((t, s) => t + Number(s.funded_amount ?? 0), 0);
  const committed = live.reduce((t, s) => t + Number(s.amount), 0);

  return (
    <>
      <Flash searchParams={sp} />
      <h1>Admin</h1>
      <p><Link href="/admin/exceptions">Journey exceptions and ownership →</Link></p>

      <div className="kpis">
        <div className="kpi"><div className="label">Investors</div><div className="value">{lps?.length ?? 0}</div></div>
        <div className="kpi"><div className="label">Accreditations to review</div><div className="value">{pending?.length ?? 0}</div></div>
        <div className="kpi"><div className="label">Committed</div><div className="value">{usd(committed)}</div></div>
        <div className="kpi"><div className="label">Funded</div><div className="value">{usd(raised)}</div></div>
      </div>

      {/* ── Accreditation queue ── */}
      <section className="card">
        <h2>Accreditation review</h2>
        {(pending ?? []).length === 0 && <p className="muted">Nothing waiting.</p>}
        {(pending ?? []).map((a) => {
          const ent = a.investing_entities;
          const sub = (a.subscriptions ?? [])[0];
          return (
            <div key={a.id} className="card" style={{ background: "var(--bg)" }}>
              <div className="spread">
                <div>
                  <strong>{ent?.legal_name}</strong>{" "}
                  <span className="muted small">
                    {ENTITY_LABEL[ent?.entity_type]} · {ent?.profiles?.full_name ?? ent?.profiles?.email}
                  </span>
                </div>
                <Badge value="pending" label={METHOD_LABEL[a.method as AccredMethod]} />
              </div>
              <div className="small" style={{ margin: "8px 0" }}>
                {sub && <>For {sub.deals?.name} · {usd(sub.amount)} · </>}
                Submitted {date(a.created_at)}
                {a.letter_date && <> · Letter dated {date(a.letter_date)}</>}
                {a.verifier_name && <> · {a.verifier_name} ({a.verifier_type})</>}
              </div>
              {a.file_path && (
                <p className="small"><a href={`/files?path=${encodeURIComponent(a.file_path)}`} target="_blank">Open letter ↗</a></p>
              )}
              {a.method === "high_minimum" && (
                <ul className="small">
                  {HIGH_MIN_REPS.map((r) => <li key={r.key}>{a.reps?.[r.key] ? "✓" : "✗"} {r.text}</li>)}
                  <li className="muted">Signed by {a.reps?.signed_by} at {a.reps?.signed_at}</li>
                </ul>
              )}
              <details className="small" style={{ margin: "6px 0 10px" }}>
                <summary>Review checklist</summary>
                <ul>
                  <li>Letter is from a CPA, attorney, RIA or broker-dealer (check license / CRD if unfamiliar).</li>
                  <li>It names this investor/entity and says they took reasonable steps to verify accredited status.</li>
                  <li>Dated within the last 90 days.</li>
                  <li>High-min: amount clears threshold and you have no knowledge the investment is third-party financed.</li>
                </ul>
              </details>
              <form action={reviewAccreditation} className="row">
                <input type="hidden" name="accreditation_id" value={a.id} />
                <input name="notes" placeholder="Note (required to reject)" style={{ flex: 1, minWidth: 200 }} />
                <button name="decision" value="verified" type="submit">Verify</button>
                <button name="decision" value="rejected" type="submit" className="danger">Reject</button>
              </form>
            </div>
          );
        })}
      </section>

      <div className="grid">
        {/* ── Deals ── */}
        <section className="card">
          <h2>Deals</h2>
          {(deals ?? []).map((d) => {
            const n = live.filter((s) => s.deal_id === d.id).length;
            return (
              <div key={d.id} className="spread" style={{ padding: "8px 0", borderBottom: "1px solid var(--line)" }}>
                <Link href={`/admin/deals/${d.id}`}>{d.name}</Link>
                <span className="small">
                  {n}/{d.max_investors} · <Badge value={d.status} />
                </span>
              </div>
            );
          })}
          <details style={{ marginTop: 12 }}>
            <summary>New deal</summary>
            <form action={createDeal} style={{ marginTop: 10 }}>
              <div className="field"><label>Name</label><input name="name" required placeholder="Sample Storage Offering" /></div>
              <div className="row">
                <div className="field" style={{ flex: 1 }}><label>Minimum</label><input name="min_investment" inputMode="decimal" placeholder="50000" /></div>
                <div className="field" style={{ flex: 1 }}><label>Target raise</label><input name="target_raise" inputMode="decimal" /></div>
                <div className="field" style={{ width: 110 }}><label>Max LPs</label><input name="max_investors" defaultValue={25} /></div>
              </div>
              <button type="submit">Create draft</button>
            </form>
          </details>
        </section>

        {/* ── Investors ── */}
        <section className="card">
          <h2>Investors</h2>
          {(lps ?? []).map((p) => (
            <div key={p.id} style={{ padding: "8px 0", borderBottom: "1px solid var(--line)" }}>
              <div>{p.full_name ?? p.email}</div>
              <div className="small muted">
                {p.email}
                {p.investing_entities?.length ? ` · ${p.investing_entities.map((e: { legal_name: string }) => e.legal_name).join(", ")}` : ""}
              </div>
            </div>
          ))}
          <details style={{ marginTop: 12 }} open={(lps ?? []).length === 0}>
            <summary>Invite investor</summary>
            <form action={inviteInvestor} style={{ marginTop: 10 }}>
              <div className="field"><label>Full name</label><input name="full_name" required /></div>
              <div className="field"><label>Email</label><input name="email" type="email" required /></div>
              <button type="submit">Send invite</button>
            </form>
          </details>
        </section>
      </div>
    </>
  );
}
