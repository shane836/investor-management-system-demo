// Presentation fixtures, independent of real Sample results and onboarding dates.
export function buildDemoReport(contributed: number) {
  const distributions = [
    { period: 'Q1 2026', paid: 'Apr 15, 2026', basisPoints: 125 },
    { period: 'Q2 2026', paid: 'Jul 15, 2026', basisPoints: 150 },
    { period: 'Q3 2026', paid: 'Oct 15, 2026', basisPoints: 175 },
  ].map(row => ({ ...row, amount: Math.round(contributed * row.basisPoints / 100) / 100 }));
  return {
    source: 'simulated' as const, contributed, returnedCapital: 0, unreturnedCapital: contributed,
    distributed: Math.round(distributions.reduce((sum, row) => sum + row.amount, 0) * 100) / 100, distributions,
    operations: [
      { period: 'Q1 2026', revenue: 168000, expenses: 102000, noi: 66000, occupancy: 69 },
      { period: 'Q2 2026', revenue: 182000, expenses: 107000, noi: 75000, occupancy: 76 },
      { period: 'Q3 2026', revenue: 196000, expenses: 110000, noi: 86000, occupancy: 82 },
    ],
  };
}
