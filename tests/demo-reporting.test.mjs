import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildDemoReport } from '../lib/demo-reporting.ts';

test('illustrative income distributions do not reduce unreturned contributed capital', () => {
  const report = buildDemoReport(50000);
  assert.equal(report.distributed, 2250);
  assert.equal(report.returnedCapital, 0);
  assert.equal(report.unreturnedCapital, 50000);
  assert.equal(report.distributions.reduce((sum, row) => sum + row.amount, 0), report.distributed);
});

test('sample reporting follows selected commitment and operating results reconcile', () => {
  const report = buildDemoReport(100000);
  assert.equal(report.distributed, 4500);
  assert.equal(report.contributed, 100000);
  for (const quarter of report.operations) assert.equal(quarter.revenue - quarter.expenses, quarter.noi);
  assert.equal(report.source, 'simulated');
});
