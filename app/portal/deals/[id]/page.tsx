import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth";
import {
  HIGH_MIN_REPS,
  LETTER_VALID_DAYS,
  highMinimumEligible,
  highMinimumThreshold,
  isAccreditationValid,
  METHOD_LABEL,
  type AccredMethod,
  type EntityType,
} from "@/lib/accreditation";
import { Badge, Flash } from "@/app/components/Topbar";
import { IR_EMAIL, STATUS_LABEL, date, usd } from "@/lib/util";
import {
  createSubscription,
  submitAccreditation,
  uploadSignedSubscription,
  useExistingAccreditation,
  withdrawSubscription,
} from "@/app/portal/actions";

const STEPS = [
  { key: "committed", label: "1 · Commit" },
  { key: "accreditation", label: "2 · Accreditation" },
  { key: "documents", label: "3 · Sign" },
  { key: "funding", label: "4 · Fund" },
] as const;
const ORDER = ["committed", "accreditation", "documents", "funding", "funded"];

type Props = { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | undefined>> };

export default async function DealPage({ params, searchParams }: Props) {
  const { id } = await params;
  const sp = await searchParams;
  const { supabase } = await requireUser();

  const { data: deal } = await supabase.from("deals").select("*").eq("id", id).single();
  if (!deal) notFound();

  const [{ data: entities }, { data: subs }, { data: docs }, { data: accs }, { data: priv }] = await Promise.all([
    supabase.from("investing_entities").select("*").order("created_at"),
    supabase.from("subscriptions").select("*, investing_entities(legal_name, entity_type)").eq("deal_id", id),
    supabase.from("documents").select("*").eq("deal_id", id).is("entity_id", null).order("created_at"),
    supabase.from("accreditations").select("*").order("created_at", { ascending: false }),
    supabase.from("deal_private").select("wire_instructions").eq("deal_id", id).maybeSingle(),
  ]);

  const sub = (subs ?? []).find((s) => !["withdrawn", "rejected"].includes(s.status));
  const templates = (docs ?? []).filter((d) => d.kind === "subscription_template");
  const offeringDocs = (docs ?? []).filter((d) => d.kind !== "subscription_template");

  return (
    <>
      <Flash searchParams={sp} />
      <div className="spread">
        <h1>{deal.name}</h1>
        <Link href="/portal" className="small">← Portfolio</Link>
      </div>
      <p className="muted">
        Minimum {usd(deal.min_investment)}
        {deal.target_raise ? ` · Raising ${usd(deal.target_raise)}` : ""} · Rule 506(c) offering — accredited investors only
      </p>
      {sub?.minimum_exception_active && (
        <div className="notice">
          Your sponsor approved a {usd(sub.amount)} commitment for {sub.investing_entities?.legal_name}.
          Accreditation and signing are still required before funding.
        </div>
      )}

      {offeringDocs.length > 0 && (
        <section className="card">
          <h2>Offering documents</h2>
          <ul>
            {offeringDocs.map((d) => (
              <li key={d.id}><a href={`/files?path=${encodeURIComponent(d.file_path)}`}>{d.title}</a></li>
            ))}
          </ul>
        </section>
      )}

      <section className="card">
        <h2>Invest</h2>
        {sub && (
          <div className="steps">
            {STEPS.map((s) => {
              const cur = ORDER.indexOf(sub.status);
              const idx = ORDER.indexOf(s.key);
              const cls = idx < cur ? "done" : idx === cur ? "current" : "";
              return <div key={s.key} className={`step ${cls}`}>{s.label}</div>;
            })}
          </div>
        )}

        {/* ── No subscription yet: commit ── */}
        {!sub && deal.status !== "open" && <p className="muted">This offering isn't accepting new investors.</p>}
        {!sub && deal.status === "open" && (
          (entities ?? []).length === 0 ? (
            <p>
              First, <Link href={`/portal/entities/new?next=/portal/deals/${id}`}>add the person or entity you'll invest through</Link>.
            </p>
          ) : (
            <form action={createSubscription} style={{ maxWidth: 420 }}>
              <input type="hidden" name="deal_id" value={id} />
              <div className="field">
                <label htmlFor="entity_id">Invest as</label>
                <select id="entity_id" name="entity_id" required>
                  {entities!.map((e) => <option key={e.id} value={e.id}>{e.legal_name}</option>)}
                </select>
              </div>
              <div className="field">
                <label htmlFor="amount">Commitment (USD)</label>
                <input id="amount" name="amount" inputMode="decimal" required placeholder={String(deal.min_investment)} />
              </div>
              <button type="submit">Commit</button>
              <p className="small muted">Non-binding until your subscription agreement is countersigned.</p>
            </form>
          )
        )}

        {/* ── Step 2: accreditation ── */}
        {sub?.status === "committed" && (
          <AccreditationStep dealId={id} sub={sub} accs={accs ?? []} />
        )}

        {sub?.status === "accreditation" && (
          <div className="notice warn">
            Your accreditation is under review — usually within 1 business day. We'll reach out once it's approved,
            and this page will move you to the next step.
          </div>
        )}

        {/* ── Step 3: sign ── */}
        {sub?.status === "documents" && (
          <div className="stack">
            {sub.signed_doc_path ? (
              <div className="notice ok">
                Signed documents received. We'll countersign and post wire instructions here.
              </div>
            ) : (
              <>
                <p>Accreditation verified. Download, sign, and upload your subscription packet.</p>
                {templates.length === 0 ? (
                  <p className="muted">Subscription documents will be posted shortly.</p>
                ) : (
                  <ul>
                    {templates.map((d) => (
                      <li key={d.id}><a href={`/files?path=${encodeURIComponent(d.file_path)}`}>{d.title}</a></li>
                    ))}
                  </ul>
                )}
                <form action={uploadSignedSubscription} className="row">
                  <input type="hidden" name="sub_id" value={sub.id} />
                  <input type="hidden" name="deal_id" value={id} />
                  <input type="file" name="file" accept="application/pdf" required style={{ maxWidth: 320 }} />
                  <button type="submit">Upload signed packet</button>
                </form>
              </>
            )}
          </div>
        )}

        {/* ── Step 4: fund ── */}
        {sub?.status === "funding" && (
          <div className="stack">
            <p>
              Countersigned. Please wire <strong>{usd(sub.amount, 2)}</strong> using the instructions below.
            </p>
            <div className="notice bad">
              <strong>Wire fraud warning:</strong> we will never change wire instructions by email. Before sending,
              call us at a number you already have to confirm these details.
            </div>
            <pre className="wire">{priv?.wire_instructions ?? "Wire instructions will appear here."}</pre>
            <p className="small muted">Reference: {sub.investing_entities?.legal_name} — {deal.name}</p>
          </div>
        )}

        {sub?.status === "funded" && (
          <div className="notice ok">
            Funded {date(sub.funded_at)} — {usd(sub.funded_amount ?? sub.amount, 2)}. Welcome aboard.
          </div>
        )}

        {sub && ["committed", "accreditation", "documents"].includes(sub.status) && (
          <form action={withdrawSubscription} style={{ marginTop: 16 }}>
            <input type="hidden" name="sub_id" value={sub.id} />
            <input type="hidden" name="deal_id" value={id} />
            <button className="link" type="submit">Withdraw this commitment</button>
          </form>
        )}

        {sub && (
          <p className="small muted" style={{ marginTop: 12 }}>
            {sub.investing_entities?.legal_name} · {usd(sub.amount)} · <Badge value={sub.status} label={STATUS_LABEL[sub.status]} />
            {IR_EMAIL && <> · Questions? <a href={`mailto:${IR_EMAIL}`}>{IR_EMAIL}</a></>}
          </p>
        )}
      </section>
    </>
  );
}

type Sub = { id: string; amount: number; entity_id: string; investing_entities: { entity_type: EntityType } | null };
type Acc = {
  id: string;
  entity_id: string;
  method: AccredMethod;
  status: string;
  expires_at: string | null;
  letter_date: string | null;
  notes: string | null;
};

function AccreditationStep({ dealId, sub, accs }: { dealId: string; sub: Sub; accs: Acc[] }) {
  const type = (sub.investing_entities?.entity_type ?? "individual") as EntityType;
  const amount = Number(sub.amount);
  const threshold = highMinimumThreshold(type);
  const highMinOk = highMinimumEligible(type, amount);

  // Reusable: verified, current, same entity, and (if high-min) amount clears threshold.
  const reusable = accs.find(
    (a) => a.entity_id === sub.entity_id && isAccreditationValid(a) && (a.method !== "high_minimum" || highMinOk),
  );

  const latest = accs.find((a) => a.entity_id === sub.entity_id); // accs are newest-first
  const lastRejected = latest?.status === "rejected" ? latest : undefined;

  return (
    <div className="stack">
      {lastRejected && (
        <div className="notice bad">
          We couldn't accept your last submission{lastRejected.notes ? `: ${lastRejected.notes}` : "."} Please try again below.
        </div>
      )}
      <p>
        This is a Rule 506(c) offering, so we're required to verify accredited-investor status — not just take your
        word for it. Choose one:
      </p>

      {reusable && (
        <form action={useExistingAccreditation} className="notice ok">
          <input type="hidden" name="sub_id" value={sub.id} />
          <input type="hidden" name="deal_id" value={dealId} />
          <input type="hidden" name="accreditation_id" value={reusable.id} />
          <div className="spread">
            <span>
              You're already verified ({METHOD_LABEL[reusable.method]}
              {reusable.expires_at ? `, valid through ${date(reusable.expires_at)}` : ""}).
            </span>
            <button type="submit">Use this verification</button>
          </div>
        </form>
      )}

      <details open={!reusable}>
        <summary>Upload a verification letter (CPA, attorney, RIA, or broker-dealer)</summary>
        <form action={submitAccreditation} style={{ marginTop: 12, maxWidth: 480 }}>
          <input type="hidden" name="sub_id" value={sub.id} />
          <input type="hidden" name="deal_id" value={dealId} />
          <input type="hidden" name="method" value="third_party_letter" />
          <p className="small muted">
            The letter must say they've verified your accredited status and be dated within the last {LETTER_VALID_DAYS} days.
          </p>
          <div className="field">
            <label>Who signed it</label>
            <select name="verifier_type" required>
              <option value="cpa">CPA</option>
              <option value="attorney">Attorney</option>
              <option value="ria">Registered investment adviser</option>
              <option value="broker_dealer">Registered broker-dealer</option>
            </select>
          </div>
          <div className="field">
            <label>Their name / firm</label>
            <input name="verifier_name" placeholder="Jane Doe, CPA — Doe & Co." required />
          </div>
          <div className="field">
            <label>Letter date</label>
            <input name="letter_date" type="date" required />
          </div>
          <div className="field">
            <label>Letter (PDF)</label>
            <input type="file" name="file" accept="application/pdf,image/png,image/jpeg" required />
          </div>
          <button type="submit">Submit for review</button>
        </form>
      </details>

      <details>
        <summary>Upload a certificate from a verification service</summary>
        <form action={submitAccreditation} style={{ marginTop: 12, maxWidth: 480 }}>
          <input type="hidden" name="sub_id" value={sub.id} />
          <input type="hidden" name="deal_id" value={dealId} />
          <input type="hidden" name="method" value="verification_service" />
          <p className="small muted">
            e.g. VerifyInvestor.com, Parallel Markets, InvestReady. Certificate must be dated within {LETTER_VALID_DAYS} days.
          </p>
          <div className="field">
            <label>Service</label>
            <input name="verifier_name" placeholder="VerifyInvestor.com" required />
          </div>
          <div className="field">
            <label>Certificate date</label>
            <input name="letter_date" type="date" required />
          </div>
          <div className="field">
            <label>Certificate (PDF)</label>
            <input type="file" name="file" accept="application/pdf,image/png,image/jpeg" required />
          </div>
          <button type="submit">Submit for review</button>
        </form>
      </details>

      <details>
        <summary>
          High-minimum investment ({usd(threshold)}+){!highMinOk && " — not available at your commitment amount"}
        </summary>
        {highMinOk ? (
          <form action={submitAccreditation} style={{ marginTop: 12, maxWidth: 560 }}>
            <input type="hidden" name="sub_id" value={sub.id} />
            <input type="hidden" name="deal_id" value={dealId} />
            <input type="hidden" name="method" value="high_minimum" />
            <p className="small muted">
              Because your commitment is at least {usd(threshold)}, you can verify by written representation instead
              of a letter. Please confirm each statement:
            </p>
            {HIGH_MIN_REPS.map((r) => (
              <label key={r.key} className="check field">
                <input type="checkbox" name={`rep_${r.key}`} required /> {r.text}
              </label>
            ))}
            <button type="submit">Submit for review</button>
          </form>
        ) : (
          <p className="small muted" style={{ marginTop: 8 }}>
            Requires a commitment of at least {usd(threshold)} for this entity type. Use a letter instead.
          </p>
        )}
      </details>
    </div>
  );
}
