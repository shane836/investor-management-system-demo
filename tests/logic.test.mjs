// Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  checkLetterDate, letterExpiry, highMinimumEligible, isAccreditationValid,
} from "../lib/accreditation.ts";
import { proRata, toCsv } from "../lib/distributions.ts";

test("letter expires 90 days after letter date", () => {
  assert.equal(letterExpiry("2026-10-01"), "2026-12-30");
});

test("letter date checks", () => {
  assert.equal(checkLetterDate("2026-10-01", "2026-10-06"), null);
  assert.match(checkLetterDate("2026-11-01", "2026-10-06"), /future/);
  assert.match(checkLetterDate("2026-06-01", "2026-10-06"), /older than 90/);
  assert.match(checkLetterDate("", "2026-10-06"), /Enter/);
});

test("high minimum thresholds", () => {
  assert.equal(highMinimumEligible("individual", 199_999), false);
  assert.equal(highMinimumEligible("joint", 200_000), true);
  assert.equal(highMinimumEligible("llc", 500_000), false);
  assert.equal(highMinimumEligible("trust", 1_000_000), true);
});

test("accreditation validity", () => {
  assert.equal(isAccreditationValid({ status: "verified", expires_at: "2026-10-06" }, "2026-10-06"), true);
  assert.equal(isAccreditationValid({ status: "verified", expires_at: "2026-10-05" }, "2026-10-06"), false);
  assert.equal(isAccreditationValid({ status: "verified", expires_at: null }, "2026-10-06"), true);
  assert.equal(isAccreditationValid({ status: "pending", expires_at: null }, "2026-10-06"), false);
});

test("pro-rata sums exactly to total", () => {
  const lines = proRata(10_000, [
    { id: "a", funded: 100_000 }, { id: "b", funded: 50_000 }, { id: "c", funded: 33_333 },
  ]);
  const sum = lines.reduce((s, l) => s + Math.round(l.amount * 100), 0);
  assert.equal(sum, 1_000_000);
  assert.equal(lines[0].amount, 5454.55); // floors to the cent; last LP absorbs rounding
});

test("pro-rata rejects empty", () => {
  assert.throws(() => proRata(100, []), /No funded/);
});

test("csv escaping", () => {
  assert.equal(toCsv([{ a: 'x,"y"', b: 1 }]), 'a,b\n"x,""y""",1');
});
