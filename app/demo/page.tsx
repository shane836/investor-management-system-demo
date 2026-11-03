"use client";

import { useState } from 'react';
import { signOut } from '@/app/login/actions';
import { createDemoJourney, advanceDemoJourney, demoBankReport, demoNotifications, DEMO_STAGES,
  type DemoAction, type DemoEntity, type DemoStage } from '@/lib/demo-journey';
import { usd } from '@/lib/util';
import Reporting from './Reporting';

const nextActions: Record<Exclude<DemoStage, 'funded'>, { label: string; action: DemoAction; owner: 'investor' | 'sponsor' }> = {
  start: { label: 'Continue with this commitment', action: 'commit', owner: 'investor' },
  committed: { label: 'Simulate verification complete', action: 'verify', owner: 'investor' },
  review: { label: 'Approve accreditation', action: 'approve', owner: 'sponsor' },
  documents: { label: 'Simulate signing complete', action: 'sign', owner: 'investor' },
  countersign: { label: 'Countersign demo packet', action: 'countersign', owner: 'sponsor' },
  funding: { label: 'Simulate incoming wire', action: 'match', owner: 'investor' },
  matched: { label: 'Mark demo investment funded', action: 'finish', owner: 'sponsor' },
};
const stageContent: Record<DemoStage, { title: string; description: string }> = {
  start: { title: 'How would you like to invest?', description: 'Choose an investing entity and a commitment to begin your Sample walkthrough.' },
  committed: { title: 'Verify your accreditation', description: 'Your commitment is saved. A verification partner will confirm your eligibility and return the evidence for sponsor review.' },
  review: { title: 'Accreditation ready for review', description: 'The simulated verification is complete. The sponsor reviews the evidence before opening subscription documents.' },
  documents: { title: 'Review and sign your documents', description: 'Accreditation approved. Your subscription packet is ready for the signing step.' },
  countersign: { title: 'Ready for sponsor countersign', description: 'The simulated signed packet and signing audit receipt have arrived. The sponsor countersigns before funding instructions appear.' },
  funding: { title: 'Your investment is ready to fund', description: 'The sponsor has countersigned. In the live portal, your private wire instructions would appear here.' },
  matched: { title: 'Incoming funds matched', description: 'The simulated bank feed found an incoming transfer matching this commitment. The sponsor reviews the match before completing the demo.' },
  funded: { title: 'Welcome to Sample', description: 'Your demo investment is funded. Your portfolio and documents are ready to view.' },
};
const entityLabels: Record<DemoEntity, string> = { individual: 'Individual', joint: 'Joint', llc: 'LLC / Corporation' };

export default function DemoPage() {
  const [journey, setJourney] = useState(createDemoJourney);
  const [view, setView] = useState<'investor' | 'sponsor'>('investor');
  const [entity, setEntity] = useState<DemoEntity>('individual');
  const [amount, setAmount] = useState('50000');
  const [error, setError] = useState('');
  const [document, setDocument] = useState<string | null>(null);
  const [section, setSection] = useState<'journey' | 'reporting'>('journey');
  const stage = journey.stage;
  const current = stageContent[stage];
  const next = stage === 'funded' ? null : nextActions[stage];
  const messages = demoNotifications(journey);
  const bank = demoBankReport(journey);
  const stageIndex = DEMO_STAGES.indexOf(stage);
  const stepIndex = stageIndex === 0 ? 0 : stageIndex <= 2 ? 1 : stageIndex <= 4 ? 2 : 3;
  const documents = ['Sample offering overview', ...(journey.review.verification.evidence ? ['Accreditation evidence'] : []),
    ...(journey.review.signing.signedPdf ? ['Signed subscription packet', 'Signing audit receipt'] : [])];

  function advance() {
    if (!next) return;
    try {
      const currentJourney = stage === 'start' ? createDemoJourney(entity, Number(amount)) : journey;
      const updated = advanceDemoJourney(currentJourney, next.action);
      setJourney(updated);
      if (updated.stage === 'funded') setSection('reporting');
      setError(''); setDocument(null);
    } catch (cause) {
      console.error('Demo journey action failed', cause);
      setError(cause instanceof Error ? cause.message : 'The demo could not advance. Reset and try again.');
    }
  }
  function reset() {
    setJourney(createDemoJourney()); setView('investor'); setEntity('individual');
    setAmount('50000'); setError(''); setDocument(null); setSection('journey');
  }

  return (
    <div className={`demo-page theme-${view}`}><main className="shell demo-shell">
      <header className="topbar demo-topbar">
        <a className="brand" href="/demo">Sample Investment Partners</a>
        <div className="row">
          <span className="badge">Interactive demo</span>
          <button className="secondary" onClick={reset}>Reset demo</button>
          <form action={signOut}><button className="secondary" type="submit">Sign out</button></form>
        </div>
      </header>
      <div className="notice warn small">Demo only · Synthetic investor and offering data. Verification, signing, bank activity and emails are simulated. Refresh resets the walkthrough.</div>
      <div className="spread demo-heading">
        <div><h1>{view === 'investor' ? 'Your investment journey' : 'Sponsor workspace'}</h1>
          {view === 'investor' && <p className="muted">Welcome, Alex Morgan</p>}</div>
        <nav className="row" aria-label="Demo perspective">
          <button className={view === 'investor' ? '' : 'secondary'} aria-pressed={view === 'investor'} onClick={() => setView('investor')}>Investor view</button>
          <button className={view === 'sponsor' ? '' : 'secondary'} aria-pressed={view === 'sponsor'} onClick={() => setView('sponsor')}>Sponsor view</button>
        </nav>
      </div>
      <nav className="demo-section-nav" aria-label="Demo sections">
        <button className={section === 'journey' ? '' : 'secondary'} aria-pressed={section === 'journey'} onClick={() => setSection('journey')}>Investment journey</button>
        <button className={section === 'reporting' ? '' : 'secondary'} aria-pressed={section === 'reporting'} onClick={() => setSection('reporting')}>Reporting</button>
      </nav>
      {section === 'reporting' ? <Reporting amount={journey.amount} sponsor={view === 'sponsor'} /> : <>
      <div className="kpis">
        <div className="kpi"><div className="label">{stage === 'funded' ? 'Invested' : 'Your commitment'}</div><div className="value">{stage === 'start' ? '—' : usd(journey.amount)}</div></div>
        <div className="kpi"><div className="label">Offering minimum</div><div className="value">$50,000</div></div>
        <div className="kpi"><div className="label">Investment status</div><div className="value demo-status">{stage === 'funded' ? 'Funded' : stage === 'start' ? 'Not started' : 'In progress'}</div></div>
      </div>
      <div className="demo-columns">
        <div>
          <section className="card" aria-labelledby="journey-title">
            <div className="spread"><h2>Sample Self Storage</h2><span className={`badge ${stage === 'funded' ? 'ok' : ''}`}>{stage === 'funded' ? 'Funded · Demo' : 'Open offering · Demo'}</span></div>
            <div className="steps" aria-label="Investment progress">
              {['Commit', 'Verify', 'Sign', 'Fund'].map((label, i) => <div key={label} aria-current={i === stepIndex ? 'step' : undefined}
                className={`step ${stage === 'funded' || i < stepIndex ? 'done' : i === stepIndex ? 'current' : ''}`}>{i + 1} · {label}</div>)}
            </div>
            <div aria-live="polite"><h2 id="journey-title">{current.title}</h2><p className="muted">{current.description}</p></div>
            {error && <p className="notice bad" role="alert">{error}</p>}
            {stage === 'start' && <>
              <div className="demo-entity-options">
                {(Object.entries(entityLabels) as [DemoEntity, string][]).map(([value, label]) => <button key={value} className={entity === value ? '' : 'secondary'}
                  aria-pressed={entity === value} onClick={() => setEntity(value)}>{label}</button>)}
                <button disabled aria-describedby="ira-note">I’m investing with an IRA</button>
              </div>
              <p id="ira-note" className="small muted">Automatic handoff to Alto — coming later.</p>
              <div className="field"><label htmlFor="demo-amount">Commitment (USD)</label><input id="demo-amount" type="number" min="50000" step="0.01" value={amount} onChange={e => setAmount(e.target.value)} /></div>
            </>}
            {stage !== 'start' && <div className="demo-summary small"><strong>Alex Morgan · {entityLabels[journey.entity]}</strong><span>{usd(journey.amount)} commitment</span></div>}
            {journey.review.verification.evidence && <p className="small"><span className="badge ok">Evidence received · Simulated</span></p>}
            {journey.review.signing.signedPdf && <p className="small"><span className="badge ok">Signed packet + audit receipt · Simulated</span></p>}
            {stage === 'funding' && <div className="notice">Demo funding reference: <strong>DEMO-SAMPLE</strong><p className="small">Wire instructions are omitted from this walkthrough. Use the button below to simulate the incoming transfer.</p></div>}
            {bank.transactions.length > 0 && <div className="notice ok">{usd(bank.proposedMatchedCents / 100)} incoming transfer matched · Simulated
              <p className="small">Live bank acceptance remains disabled. This walkthrough only changes its own display.</p></div>}
            {next && (next.owner === view ? <button onClick={advance}>{next.label}</button> : <div className="notice">
              <p>The next step belongs to the {next.owner}.</p><button className="secondary" onClick={() => setView(next.owner)}>Switch to {next.owner} view</button>
            </div>)}
            {stage === 'funded' && <div className="notice ok"><p>Walkthrough complete. No funds were transferred and no messages were sent.</p><button onClick={() => setSection('reporting')}>View reporting</button></div>}
          </section>
          <section className="card"><h2>Documents</h2><p className="small muted">Illustrative previews. No investor files are stored in this demo.</p>
            {documents.map(title => <div className="spread demo-doc" key={title}><span>{title}</span><button className="link" onClick={() => setDocument(document === title ? null : title)}>{document === title ? 'Close preview' : 'Preview'}</button></div>)}
            {document && <article className="notice" aria-live="polite"><h3>{document}</h3><p>Sample for Alex Morgan’s Sample investment.</p><p className="small">This placeholder illustrates where the document will appear. It is not an offering document, accreditation certificate or signed agreement.</p></article>}
          </section>
        </div>
        <aside>
          {view === 'sponsor' && <section className="card"><h2>Investor queue</h2><p><strong>Alex Morgan</strong><br /><span className="small muted">alex.morgan@example.com</span></p><p>{stage === 'start' ? 'Awaiting commitment' : current.title}</p><span className="badge">{next ? `Next: ${next.owner}` : 'Complete'}</span></section>}
          <section className="card"><h2>Activity</h2>{journey.activity.length === 0 ? <p className="muted small">Start a commitment to see the journey unfold.</p> : <ol className="demo-activity">{journey.activity.map((item, index) => <li key={item}><span className="muted small">Step {index + 1}</span><div>{item}</div></li>)}</ol>}</section>
          <section className="card"><h2>Notification previews</h2><p className="small muted">Illustrates reminders after two business days at the current step. Nothing is sent.</p>
            {messages.length === 0 && <p className="small muted">{stage === 'funded' ? 'Journey complete. Reminders stop.' : 'No notifications yet.'}</p>}
            {messages.map(message => <div className="demo-message" key={message.dedupeKey}><span className="badge">{message.kind === 'gp_digest' ? 'Sponsor digest' : 'Investor reminder'}</span><h3>{message.subject}</h3><p className="small muted">{message.body}</p></div>)}
          </section>
        </aside>
      </div>
      </>}
    </main></div>
  );
}
