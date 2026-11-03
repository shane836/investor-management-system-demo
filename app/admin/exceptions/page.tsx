import Link from "next/link";
import { requireGP } from "@/lib/auth";
import { Flash } from "@/app/components/Topbar";
import { date, STATUS_LABEL } from "@/lib/util";
import { openJourneyException, updateJourneyException } from "@/app/admin/actions";

const KINDS = { verification: "Verification", signing: "Signing", funding: "Funding reconciliation", documents: "Document recovery", other: "Other" } as const;

export default async function JourneyExceptions({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const { supabase, user } = await requireGP();
  const [issuesResult, subscriptionsResult, ownersResult] = await Promise.all([
    supabase.from("journey_exceptions").select("*").order("created_at", { ascending: false }),
    supabase.from("subscriptions").select("id, deal_id, status, investing_entities(legal_name), deals(name)").order("created_at"),
    supabase.from("profiles").select("id, full_name, email").eq("role", "gp").order("email"),
  ]);
  for (const result of [issuesResult, subscriptionsResult, ownersResult]) {
    if (result.error) throw new Error(`Could not load journey exceptions: ${result.error.message}`);
  }
  const issues = issuesResult.data ?? [];
  const subs = subscriptionsResult.data ?? [];
  const owners = ownersResult.data ?? [];
  const subscriptions = new Map(subs.map((s) => [s.id, s]));
  const ownerName = (id: string) => {
    const owner = owners.find((p) => p.id === id);
    return owner?.full_name ?? owner?.email ?? "Recorded sponsor";
  };
  const subscriptionLabel = (id: string) => {
    const sub = subscriptions.get(id);
    if (!sub) return "Recorded investment";
    const entity = Array.isArray(sub.investing_entities) ? sub.investing_entities[0] : sub.investing_entities;
    const deal = Array.isArray(sub.deals) ? sub.deals[0] : sub.deals;
    return `${entity?.legal_name ?? "Entity"} · ${deal?.name ?? "Deal"} · ${STATUS_LABEL[sub.status] ?? sub.status}`;
  };
  const open = issues.filter((issue) => issue.status === "open");
  return (
    <>
      <Flash searchParams={sp} />
      <div className="spread"><h1>Journey exceptions</h1><Link href="/admin">← Admin</Link></div>
      <p className="muted">{open.length} open. Record problems, assign a sponsor and retain the resolution. Resolving an exception does not approve accreditation, release wires or mark an investment funded.</p>
      <section className="card">
        <h2>Record an exception</h2>
        <form action={openJourneyException}>
          <div className="field"><label htmlFor="issue-sub">Investment</label><select id="issue-sub" name="sub_id" required><option value="">Choose an investment</option>{subs.map((s) => <option key={s.id} value={s.id}>{subscriptionLabel(s.id)}</option>)}</select></div>
          <div className="field"><label htmlFor="issue-kind">Category</label><select id="issue-kind" name="kind">{Object.entries(KINDS).map(([value,label]) => <option key={value} value={value}>{label}</option>)}</select></div>
          <div className="field"><label htmlFor="issue-summary">Problem and next action</label><textarea id="issue-summary" name="summary" required /><p className="small muted">Keep evidence in private document storage; describe the action needed here.</p></div>
          <div className="field"><label htmlFor="issue-owner">Responsible sponsor</label><select id="issue-owner" name="owner_id" defaultValue={user.id} required>{owners.map((p) => <option key={p.id} value={p.id}>{p.full_name ?? p.email}</option>)}</select></div>
          <button type="submit" disabled={subs.length === 0}>Record exception</button>
        </form>
      </section>
      <section className="card"><h2>Open exceptions</h2>
        {open.length === 0 && <p className="muted">No open exceptions.</p>}
        {open.map((issue) => (
          <article className="card" key={issue.id}>
            <h3>{KINDS[issue.kind as keyof typeof KINDS]} · {subscriptionLabel(issue.subscription_id)}</h3>
            <p className="small muted">Recorded {date(issue.created_at)} by {ownerName(issue.created_by)} · Updated {date(issue.updated_at)}</p>
            <form action={updateJourneyException}>
              <input type="hidden" name="exception_id" value={issue.id} /><input type="hidden" name="version" value={issue.version} />
              <div className="field"><label htmlFor={`owner-${issue.id}`}>Responsible sponsor</label><select id={`owner-${issue.id}`} name="owner_id" defaultValue={issue.owner_id} required>{owners.map((p) => <option key={p.id} value={p.id}>{p.full_name ?? p.email}</option>)}</select></div>
              <div className="field"><label htmlFor={`summary-${issue.id}`}>Problem and next action</label><textarea id={`summary-${issue.id}`} name="summary" defaultValue={issue.summary} required /></div>
              <div className="field"><label htmlFor={`resolution-${issue.id}`}>Resolution (required when resolving)</label><textarea id={`resolution-${issue.id}`} name="resolution" /></div>
              <div className="row"><button name="decision" value="save" type="submit">Save owner/details</button><button name="decision" value="resolve" type="submit">Resolve exception</button></div>
            </form>
          </article>
        ))}
      </section>
      <section className="card"><h2>Resolved history</h2>
        {issues.filter((issue) => issue.status === "resolved").map((issue) => <article key={issue.id} className="card"><strong>{subscriptionLabel(issue.subscription_id)}</strong><p>{issue.summary}</p><p>{issue.resolution}</p><p className="small muted">Resolved {date(issue.resolved_at)} by {ownerName(issue.resolved_by)}</p></article>)}
      </section>
    </>
  );
}
