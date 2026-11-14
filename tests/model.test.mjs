// Run: node --test tests/
import test from "node:test";
import assert from "node:assert/strict";
import { allInRate, snapshot, creditBand, project, ebitdaCushion, maturityWall, recovery } from "../js/model.js";
import { fromPreset } from "../js/presets.js";

const near = (a, b, tol = 1e-6) => assert.ok(Math.abs(a - b) <= tol, `${a} vs ${b}`);

test("all-in rate: float adds base and shock, floors at zero; fixed ignores both", () => {
  near(allInRate({ type: "float", rate: 3.5 }, 4.0, 100), 0.085);
  near(allInRate({ type: "float", rate: 1 }, 0.5, -300), 0);
  near(allInRate({ type: "fixed", rate: 8 }, 4.0, 500), 0.08);
});

test("snapshot: leverage, coverage and cumulative leverage add up", () => {
  const s = fromPreset("lbo", 2026);
  const snap = snapshot(s);
  near(snap.debt, 20 + 1000 + 400);
  near(snap.netDebt, 1420 - 80);
  near(snap.netLev, 1340 / 250);
  near(snap.rows[snap.rows.length - 1].cumLev, 1420 / 250);
  // interest: RCF 20 @ 7.55%, TLB 1000 @ 8.05%, notes 400 @ 8.25%, fee on 130 undrawn
  near(snap.interest, 20 * 0.0755 + 1000 * 0.0805 + 400 * 0.0825 + 130 * 0.0035, 1e-9);
  near(snap.coverage, 250 / snap.interest);
});

test("credit band takes the weaker of leverage and coverage", () => {
  assert.equal(creditBand(1.0, 10).band, "A");
  assert.equal(creditBand(1.0, 2.5).band, "B");
  assert.equal(creditBand(7.0, 10).band, "CCC");
  assert.equal(creditBand(5.4, 2.2).band, "B");
  assert.equal(creditBand(9, 0.8).band, "CC");
});

test("projection: no shock IG credit passes; deep shock breaches", () => {
  const s = fromPreset("ig", 2026);
  const base = project(s, { ebitdaShock: 0, rateShockBp: 0, sweep: 0, refiOpen: true });
  assert.equal(base.firstBreach, null);
  const hit = project(s, { ebitdaShock: -50, rateShockBp: 300, sweep: 0, refiOpen: true });
  assert.ok(hit.firstBreach !== null);
});

test("projection: shut refinancing market forces repayment and can create a shortfall", () => {
  const s = fromPreset("stressed", 2026);
  const open = project(s, { ebitdaShock: 0, rateShockBp: 0, sweep: 0, refiOpen: true });
  const shut = project(s, { ebitdaShock: 0, rateShockBp: 0, sweep: 0, refiOpen: false });
  // the stressed preset burns cash even with markets open; shutting them must make it worse
  assert.ok(shut.shortfallTotal > open.shortfallTotal);
  assert.ok(shut.firstBreach <= (open.firstBreach ?? Infinity));
  const ig = fromPreset("ig", 2026);
  assert.equal(project(ig, { ebitdaShock: 0, rateShockBp: 0, sweep: 0, refiOpen: true }).shortfallTotal, 0);
});

test("ebitda cushion is the decline that lands exactly on the covenant", () => {
  const s = fromPreset("lbo", 2026);
  const c = ebitdaCushion(s) / 100;
  const snap = snapshot(s);
  near(snap.netDebt / (s.ebitda * (1 - c)), s.cov.maxLev, 1e-9);
});

test("maturity wall conserves principal", () => {
  const s = fromPreset("lbo", 2026);
  const w = maturityWall(s);
  const total = w.items.reduce((a, i) => a + i.amount, 0);
  near(total, 20 + 1000 + 400, 1e-9);
});

test("recovery: absolute priority, pro rata within a class, fulcrum identified", () => {
  const s = fromPreset("lbo", 2026);
  // EV 1,000; admin 0; RCF fully drawn 150 + TLB 1000 = 1,150 first lien
  const r = recovery(s, { ebitda: 200, multiple: 5, adminPct: 0, rcfFull: true });
  near(r.ev, 1000);
  const first = r.classes.find((c) => c.rank === 1);
  near(first.pct, 1000 / 1150);
  assert.equal(r.fulcrum, 1);
  assert.equal(r.classes.find((c) => c.rank === 3).paid, 0);
  near(first.members[0].recovered / first.members[0].claim, first.members[1].recovered / first.members[1].claim);
  // big EV: everyone paid, residual to equity
  const rich = recovery(s, { ebitda: 400, multiple: 8, adminPct: 5, rcfFull: false });
  assert.equal(rich.fulcrum, null);
  near(rich.equity, 3200 * 0.95 - 1420);
});
