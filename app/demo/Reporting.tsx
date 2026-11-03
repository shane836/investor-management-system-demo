"use client";

import { useState } from 'react';
import { buildDemoReport } from '@/lib/demo-reporting';
import { usd } from '@/lib/util';

export default function Reporting({ amount, sponsor }: { amount: number; sponsor: boolean }) {
  const report = buildDemoReport(amount);
  const [statement, setStatement] = useState(false);
  const [period, setPeriod] = useState('Q3 2026');
  const quarter = report.operations.find(row => row.period === period)!;
  const distributions = report.distributions.filter(row => row.period <= period);
  const distributed = distributions.reduce((sum, row) => sum + row.amount, 0);
  return (
    <div className="demo-reporting">
      <div className="spread demo-report-heading"><div><h2>{sponsor ? 'Project reporting' : 'Your investment report'}</h2><p className="muted">Sample Self Storage · {period}</p></div>
        <div className="field"><label htmlFor="report-period">Reporting period</label><select id="report-period" value={period} onChange={event => setPeriod(event.target.value)}>{report.operations.map(row => <option key={row.period}>{row.period}</option>)}</select></div>
      </div>
      <p className="notice small">Sample reporting for a seasoned investment. All figures and dates are illustrative, independent of onboarding progress; these are not actual Sample results.</p>
      <div className="kpis">
        <div className="kpi"><div className="label">Capital contributed</div><div className="value">{usd(report.contributed)}</div></div>
        <div className="kpi"><div className="label">Distributions through period</div><div className="value">{usd(distributed, 2)}</div></div>
        <div className="kpi"><div className="label">Unreturned capital</div><div className="value">{usd(report.unreturnedCapital)}</div></div>
      </div>
      <div className="demo-columns">
        <div>
          <section className="card"><div className="spread"><h2>Property performance</h2><span className="badge">Illustrative operations</span></div>
            <p className="small muted">Property-level results; your capital and distributions appear separately.</p>
            <div className="table-wrap"><table><caption className="sr-only">Quarterly property operating results through {period}</caption><thead><tr><th scope="col">Quarter</th><th scope="col" className="num">Revenue</th><th scope="col" className="num">Operating expenses</th><th scope="col" className="num">Net operating income</th></tr></thead>
              <tbody>{report.operations.filter(row => row.period <= period).map(row => <tr key={row.period}><th scope="row">{row.period}</th><td className="num">{usd(row.revenue)}</td><td className="num">{usd(row.expenses)}</td><td className="num">{usd(row.noi)}</td></tr>)}</tbody></table></div>
            <div className="demo-occupancy"><div className="spread"><strong>Physical occupancy</strong><strong>{quarter.occupancy}%</strong></div><meter min="0" max="100" value={quarter.occupancy} aria-label={`Physical occupancy for ${period}`}>{quarter.occupancy}%</meter><p className="small muted">Percentage of rentable units occupied at quarter end.</p></div>
          </section>
          <section className="card"><h2>{sponsor ? 'Sample investor distributions' : 'Your distributions'}</h2><p className="small muted">Income distributions only. No return of capital is included.</p>
            <div className="table-wrap"><table><caption className="sr-only">Sample income distribution history</caption><thead><tr><th scope="col">Period</th><th scope="col">Paid</th><th scope="col" className="num">Amount</th><th scope="col">Status</th></tr></thead><tbody>{distributions.map(row => <tr key={row.period}><th scope="row">{row.period}</th><td>{row.paid}</td><td className="num">{usd(row.amount, 2)}</td><td><span className="badge ok">Paid · Sample</span></td></tr>)}</tbody><tfoot><tr><th scope="row" colSpan={2}>Total through {period}</th><td className="num">{usd(distributed, 2)}</td><td /></tr></tfoot></table></div>
          </section>
        </div>
        <aside>
          <section className="card"><h2>{sponsor ? 'Investor capital summary' : 'Your capital summary'}</h2><p className="small muted">Alex Morgan · Sample account</p><dl className="demo-capital"><div><dt>Contributed</dt><dd>{usd(report.contributed)}</dd></div><div><dt>Capital returned</dt><dd>{usd(report.returnedCapital)}</dd></div><div><dt>Unreturned capital</dt><dd>{usd(report.unreturnedCapital)}</dd></div></dl><p className="small muted">Unreturned capital is not a valuation or estimate of sale proceeds.</p>
            <button className="secondary" onClick={() => setStatement(!statement)} aria-expanded={statement} aria-controls="statement-preview">{statement ? 'Close statement' : 'Preview statement'}</button>
            {statement && <div id="statement-preview" className="notice demo-statement"><h3>Capital statement · {period}</h3><p>Alex Morgan · Sample Self Storage</p><p>Contributed {usd(report.contributed)}<br />Income distributions {usd(distributed, 2)}<br />Unreturned capital {usd(report.unreturnedCapital)}</p><span className="small muted">Sample statement preview</span></div>}
          </section>
          <section className="card"><h2>Quarterly update</h2><span className="badge">Sample sponsor update</span><p>Lease-up continued during {period}. Quarter-end occupancy reached {quarter.occupancy}% and net operating income was {usd(quarter.noi)}.</p><p className="small muted">Next-period focus: leasing activity, expense management, and investor communication.</p></section>
        </aside>
      </div>
    </div>
  );
}
