import { createEntity } from "@/app/portal/actions";
import { Flash } from "@/app/components/Topbar";
import { ENTITY_LABEL } from "@/lib/util";

export default async function NewEntity({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const sp = await searchParams;
  return (
    <section className="card" style={{ maxWidth: 520 }}>
      <Flash searchParams={sp} />
      <h1>Add investing entity</h1>
      <p className="muted small">The person or entity whose name goes on the subscription agreement.</p>
      <button type="button" disabled aria-describedby="ira-handoff-note">I’m investing with an IRA</button>
      <p id="ira-handoff-note" className="muted small">Automatic handoff to Alto — coming later.</p>
      <form action={createEntity}>
        <input type="hidden" name="next" value={sp.next ?? "/portal"} />
        <div className="field">
          <label htmlFor="legal_name">Legal name</label>
          <input id="legal_name" name="legal_name" required placeholder="e.g. Jane Smith, or Smith Family Trust dtd 1/1/2020" />
        </div>
        <div className="field">
          <label htmlFor="entity_type">Type</label>
          <select id="entity_type" name="entity_type" required>
            {Object.entries(ENTITY_LABEL).map(([v, l]) => (
              <option key={v} value={v}>{l}</option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="state">State of residence / formation</label>
          <input id="state" name="state" maxLength={2} placeholder="CA" />
        </div>
        <p className="small muted">
          We never ask for your SSN or bank account numbers in this portal. Tax ID goes on the W-9 in your subscription packet.
        </p>
        <button type="submit">Save</button>
      </form>
    </section>
  );
}
