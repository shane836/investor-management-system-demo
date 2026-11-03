import Link from "next/link";
import { notFound } from "next/navigation";
import { requireGP } from "@/lib/auth";
import { METHOD_LABEL, type AccredMethod } from "@/lib/accreditation";
import { Badge, Flash } from "@/app/components/Topbar";
import { STATUS_LABEL, date, today, usd } from "@/lib/util";
import {
  approveMinimumException,
  revokeMinimumException,
  countersign,
  createDistribution,
  markDistributionPaid,
  markFunded,
  rejectSubscription,
  updateDeal,
  uploadDocument,
} from "@/app/admin/actions";

type Props = { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | undefined>> };

const DOC_KINDS = [
  ["ppm", "PPM"],
  ["operating_agreement", "Operating agreement"],
  ["subscription_template", "Subscription packet (to sign)"],
  ["update", "Investor update"],
  ["k1", "K-1 (per investor)"],
  ["w9", "W-9 (per investor)"],
  ["other", "Other"],
] as const;

export default async function AdminDeal({ params, searchParams }: Props) {
  const { id } = await params;
  const sp = await searchParams;
  const { supabase } = await requireGP();

  const { data: deal } = await supabase.from("deals").select("*").eq("id", id).single();
  if (!deal) notFound();

  const [{ data: priv }, { data: subs }, { data: docs }, { data: dists }, { data: allEntities, error: entitiesError }] = await Promise.all([
    supabase.from("deal_private").select("wire_instructions").eq("deal_id", id).maybeSingle(),
    supabase
      .from("subscriptions")
      .select("*, investing_entities(id, legal_name, profiles(email, full_name)), accreditations(method, status, expires_at)")
      .eq("deal_id", id)
      .order("created_at"),
    supabase.from("documents").select("*, investing_entities(legal_name)").eq("deal_id", id).order("created_at", { ascending: false }),
    supabase.from("distributions").select("*, distribution_lines(amount, paid_at)").eq("deal_id", id).order("dist_date", { ascending: false }),
    supabase.from("investing_entities").select("id, legal_name, profiles(email)").order("legal_name"),
  ]);

  if (entitiesError) throw new Error(`Could not load investing entities: ${entitiesError.message}`);

  const live = (subs ?? []).filter((s) => !["withdrawn", "rejected"].includes(s.status));
  const funded = live.filter((s) => s.status === "funded");
  const fundedTotal = funded.reduce((t, s) => t + Number(s.funded_amount ?? 0), 0);
  const committed = live.reduce((t, s) => t + Number(s.amount), 0);
  const entities = live.map((s) => s.investing_entities).filter(Boolean);

  return (
    <>
      <Flash searchParams={sp} />
      <div className="spread">
        <h1>{deal.name}</h1>
        <Link href="/admin" className="small">← Admin</Link>
      </div>

      <div className="kpis">
        <div className="kpi"><div className="label">Status</div><div className="value"><Badge value={deal.status} /></div></div>
        <div className="kpi"><div className="label">Investors</div><div className="value">{live.length} / {deal.max_investors}</div></div>
        <div className="kpi"><div className="label">Committed</div><div className="value">{usd(committed)}</div></div>
        <div className="kpi"><div className="label">Funded</div><div className="value">{usd(fundedTotal)}</div></div>
      </div>

      <section className="card">
        <h2>Approve an investment amount</h2>
        <p className="small muted">Advertised minimum: {usd(deal.min_investment)}. Approve a different amount for one investment before documents/signing begins. The investor must first sign in and add their investing entity. This creates their initial commitment or updates the existing early commitment.</p>
        <form action={approveMinimumException}>
          <input type="hidden" name="deal_id" value={id} />
          <div className="field">
            <label htmlFor="exception-entity">Investing entity</label>
            <select id="exception-entity" name="entity_id" required>
              <option value="">Choose an entity</option>
              {(allEntities ?? []).map((e) => <option key={e.id} value={e.id}>{e.legal_name} · {(Array.isArray(e.profiles) ? e.profiles[0] : e.profiles)?.email}</option>)}
            </select>
          </div>
          <div className="field"><label htmlFor="exception-amount">Approved commitment (USD)</label><input id="exception-amount" name="amount" type="number" min="0.01" step="0.01" placeholder="12500 or 25000" required /></div>
          <div className="field"><label htmlFor="exception-reason">Reason for this decision</label><textarea id="exception-reason" name="reason" required /></div>
          <button type="submit" disabled={deal.status !== "open" || !allEntities?.length}>Approve this investment amount</button>
        </form>
        <p className="small muted">Applies only to this deal and entity, for the exact amount entered. Does not approve accreditation, lower accreditation thresholds or release wire instructions.</p>
      </section>

      {/* ── Subscriptions ── */}
      <section className="card">
        <h2>Subscriptions</h2>
        <div className="table-wrap">
          <table>
            <thead>
              <tr><th>Investor</th><th className="num">Amount</th><th>Accreditation</th><th>Status</th><th>Action</th></tr>
            </thead>
            <tbody>
              {(subs ?? []).map((s) => (
                <tr key={s.id}>
                  <td>
                    {s.investing_entities?.legal_name}
                    <div className="small muted">{s.investing_entities?.profiles?.email}</div>
                  </td>
                  <td className="num">
                    {usd(s.funded_amount ?? s.amount)}
                    {s.minimum_exception_amount && <div className="small muted">{s.minimum_exception_active ? "Approved exception" : "Revoked exception"}: {usd(s.minimum_exception_amount)}<br />{s.minimum_exception_reason}<br />{date(s.minimum_exception_at)}</div>}
                  </td>
                  <td className="small">
                    {s.accreditations ? (
                      <>
                        <Badge value={s.accreditations.status} />
                        <div className="muted">{METHOD_LABEL[s.accreditations.method as AccredMethod]}</div>
                        {s.accreditations.expires_at && <div className="muted">exp {date(s.accreditations.expires_at)}</div>}
                      </>
                    ) : "—"}
                  </td>
                  <td><Badge value={s.status} label={STATUS_LABEL[s.status]} /></td>
                  <td className="small">
                    {s.status === "documents" && s.signed_doc_path && (
                      <form action={countersign} className="row">
                        <input type="hidden" name="sub_id" value={s.id} />
                        <input type="hidden" name="deal_id" value={id} />
                        <a href={`/files?path=${encodeURIComponent(s.signed_doc_path)}`} target="_blank">Signed packet ↗</a>
                        <button type="submit">Countersign</button>
                      </form>
                    )}
                    {s.status === "documents" && !s.signed_doc_path && <span className="muted">Waiting on signature</span>}
                    {s.status === "funding" && (
                      <form action={markFunded} className="row">
                        <input type="hidden" name="sub_id" value={s.id} />
                        <input type="hidden" name="deal_id" value={id} />
                        <input name="funded_amount" defaultValue={s.amount} style={{ width: 110 }} />
                        <input name="funded_at" type="date" defaultValue={today()} style={{ width: 150 }} />
                        <button type="submit">Mark funded</button>
                      </form>
                    )}
                    {s.minimum_exception_active && ["committed", "accreditation"].includes(s.status) && (
                      <form action={revokeMinimumException} style={{ marginTop: 6 }}>
                        <input type="hidden" name="sub_id" value={s.id} />
                        <input type="hidden" name="deal_id" value={id} />
                        <label htmlFor={`revoke-reason-${s.id}`}>Reason for revocation</label>
                        <input id={`revoke-reason-${s.id}`} name="reason" required />
                        <button type="submit">Revoke exception and withdraw commitment</button>
                      </form>
                    )}
                    {s.status === "funded" && <span className="muted">{date(s.funded_at)}</span>}
                    {["committed", "accreditation", "documents", "funding"].includes(s.status) && (
                      <form action={rejectSubscription} style={{ marginTop: 6 }}>
                        <input type="hidden" name="sub_id" value={s.id} />
                        <input type="hidden" name="deal_id" value={id} />
                        <button type="submit" className="link">Decline</button>
                      </form>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {(subs ?? []).length === 0 && <p className="muted">No subscriptions yet.</p>}
      </section>

      <div className="grid">
        {/* ── Documents ── */}
        <section className="card">
          <h2>Documents</h2>
          <form action={uploadDocument}>
            <input type="hidden" name="deal_id" value={id} />
            <div className="field">
              <label>Type</label>
              <select name="kind">{DOC_KINDS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
            </div>
            <div className="field">
              <label>Visible to</label>
              <select name="entity_id">
                <option value="">Everyone with access to this deal</option>
                {entities.map((e) => <option key={e!.id} value={e!.id}>Only {e!.legal_name}</option>)}
              </select>
            </div>
            <div className="field"><label>Title</label><input name="title" placeholder="Q3 2026 Investor Update" /></div>
            <div className="field"><input type="file" name="file" required /></div>
            <button type="submit">Upload</button>
          </form>
          <ul className="small" style={{ marginTop: 16 }}>
            {(docs ?? []).map((d) => (
              <li key={d.id}>
                <a href={`/files?path=${encodeURIComponent(d.file_path)}`}>{d.title}</a>{" "}
                <span className="muted">· {d.kind}{d.investing_entities ? ` · ${d.investing_entities.legal_name}` : " · all"}</span>
              </li>
            ))}
          </ul>
        </section>

        {/* ── Distributions ── */}
        <section className="card">
          <h2>Distributions</h2>
          <p className="small muted">Pro-rata by funded capital. Calculate the LP pool (after pref/waterfall) in your model, enter the total here.</p>
          <form action={createDistribution}>
            <input type="hidden" name="deal_id" value={id} />
            <div className="row">
              <div className="field" style={{ flex: 1 }}><label>Total to LPs</label><input name="total" inputMode="decimal" required /></div>
              <div className="field" style={{ flex: 1 }}><label>Date</label><input name="dist_date" type="date" defaultValue={today()} required /></div>
            </div>
            <div className="field"><label>Memo</label><input name="memo" placeholder="Q3 2026 operating distribution" /></div>
            <button type="submit" disabled={funded.length === 0}>Create distribution</button>
          </form>
          <table style={{ marginTop: 16 }}>
            <tbody>
              {(dists ?? []).map((d) => {
                const unpaid = (d.distribution_lines ?? []).some((l: { paid_at: string | null }) => !l.paid_at);
                return (
                  <tr key={d.id}>
                    <td>{date(d.dist_date)}<div className="small muted">{d.memo}</div></td>
                    <td className="num">{usd(d.total, 2)}</td>
                    <td className="num small">
                      <a href={`/admin/distributions/${d.id}/export`}>CSV</a>
                      {unpaid ? (
                        <form action={markDistributionPaid} style={{ display: "inline", marginLeft: 8 }}>
                          <input type="hidden" name="distribution_id" value={d.id} />
                          <input type="hidden" name="deal_id" value={id} />
                          <button type="submit" className="link">Mark paid</button>
                        </form>
                      ) : <span className="muted"> · paid</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </section>
      </div>

      {/* ── Settings ── */}
      <section className="card">
        <h2>Deal settings</h2>
        <form action={updateDeal}>
          <input type="hidden" name="deal_id" value={id} />
          <div className="row">
            <div className="field" style={{ width: 160 }}>
              <label>Status</label>
              <select name="status" defaultValue={deal.status}>
                <option value="draft">Draft (hidden)</option>
                <option value="open">Open</option>
                <option value="closed">Closed</option>
              </select>
            </div>
            <div className="field" style={{ flex: 1 }}><label>Minimum</label><input name="min_investment" defaultValue={deal.min_investment} /></div>
            <div className="field" style={{ flex: 1 }}><label>Target raise</label><input name="target_raise" defaultValue={deal.target_raise ?? ""} /></div>
            <div className="field" style={{ width: 110 }}><label>Max LPs</label><input name="max_investors" defaultValue={deal.max_investors} /></div>
          </div>
          <div className="field">
            <label>Wire instructions (shown to an LP only after you countersign)</label>
            <textarea name="wire_instructions" defaultValue={priv?.wire_instructions ?? ""} placeholder={"Bank:\nABA:\nAccount:\nBeneficiary:\nReference: investor name + deal"} />
          </div>
          <button type="submit">Save</button>
        </form>
      </section>
    </>
  );
}
