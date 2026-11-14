// Covenant — model.js
// Pure functions: no DOM, no globals. Everything the page shows is computed
// here, so tests/model.test.mjs can check the arithmetic in Node.

export const RANKS = {
  1: "First lien secured",
  2: "Second lien secured",
  3: "Senior unsecured",
  4: "Subordinated",
};

export const COMMITMENT_FEE = 0.0035; // on undrawn revolver, a common market level

/** All-in cash interest rate for a tranche, in decimal. */
export function allInRate(t, base, shockBp = 0) {
  if (t.type === "float") return Math.max(0, (base + shockBp / 100 + t.rate) / 100);
  return t.rate / 100;
}

/** Point-in-time capital structure summary (today, before any projection). */
export function snapshot(s) {
  const ebitda = s.ebitda;
  const rcfDrawn = Math.min(s.rcf.drawn, s.rcf.commit);
  const rows = [];
  let cum = 0;
  const ordered = [...s.tranches].sort((a, b) => a.rank - b.rank || a.maturity - b.maturity);
  const rcfRow = { name: "Revolver (drawn)", rank: 1, amount: rcfDrawn, type: "float", rate: s.rcf.margin, maturity: s.rcf.maturity, amort: 0, isRcf: true };
  const all = rcfDrawn > 0 ? [rcfRow, ...ordered] : ordered;
  let interest = 0;
  let wSum = 0, wRate = 0;
  for (const t of all) {
    const r = allInRate(t, s.base);
    const int = t.amount * r;
    cum += t.amount;
    interest += int;
    wSum += t.amount;
    wRate += t.amount * r;
    rows.push({ ...t, allIn: r, interest: int, cumLev: ebitda > 0 ? cum / ebitda : Infinity });
  }
  interest += Math.max(0, s.rcf.commit - rcfDrawn) * COMMITMENT_FEE;
  const debt = cum;
  const netDebt = debt - s.cash;
  const yearNow = s.year;
  const wam = wSum > 0 ? all.reduce((a, t) => a + t.amount * Math.max(0, t.maturity - yearNow), 0) / wSum : 0;
  const liquidity = s.cash + Math.max(0, s.rcf.commit - rcfDrawn);
  return {
    rows,
    debt,
    netDebt,
    interest,
    grossLev: ebitda > 0 ? debt / ebitda : Infinity,
    netLev: ebitda > 0 ? netDebt / ebitda : Infinity,
    coverage: interest > 0 ? ebitda / interest : Infinity,
    costOfDebt: wSum > 0 ? wRate / wSum : 0,
    wam,
    liquidity,
    fcfPreDebt: ebitda - s.capex - s.nwc - Math.max(0, ebitda - s.da - interest) * s.tax / 100,
  };
}

/**
 * Indicative credit band from leverage and coverage. A deliberately simple
 * heuristic in the spirit of agency ratio guidance, NOT a rating: it takes the
 * weaker of the two signals.
 */
export function creditBand(netLev, coverage) {
  const levBands = [[1.5, "A"], [2.75, "BBB"], [4.0, "BB"], [6.5, "B"], [8.0, "CCC"]];
  const covBands = [[8, "A"], [4.5, "BBB"], [3, "BB"], [1.75, "B"], [1.0, "CCC"]];
  const order = ["A", "BBB", "BB", "B", "CCC", "CC"];
  let l = "CC";
  for (const [cap, b] of levBands) if (netLev <= cap) { l = b; break; }
  let c = "CC";
  for (const [floor, b] of covBands) if (coverage >= floor) { c = b; break; }
  const band = order[Math.max(order.indexOf(l), order.indexOf(c))];
  return { band, fromLeverage: l, fromCoverage: c, investmentGrade: band === "A" || band === "BBB" };
}

/**
 * Five-year annual projection under a stress.
 * stress = { ebitdaShock (%, negative = down), rateShockBp, growth (% p.a.),
 *            refiOpen (bool), sweep (% of excess cash) }
 */
export function project(s, stress, years = 5) {
  const shock = 1 + (stress.ebitdaShock || 0) / 100;
  const rateBp = stress.rateShockBp || 0;
  const g = (stress.growth ?? s.growth) / 100;
  const sweep = Math.max(0, Math.min(100, stress.sweep ?? 0)) / 100;

  const tr = s.tranches.map((t) => ({ ...t, bal: t.amount, orig: t.amount }));
  let rcf = Math.min(s.rcf.drawn, s.rcf.commit);
  let cash = s.cash;
  const out = [];
  let shortfallTotal = 0;

  for (let k = 1; k <= years; k++) {
    const year = s.year + k;
    const ebitda = s.ebitda * Math.pow(1 + g, k) * shock;
    const rcfAvail = year <= s.rcf.maturity || stress.refiOpen;

    // interest on opening balances (annual model, no intra-year timing)
    let interest = 0;
    for (const t of tr) interest += t.bal * allInRate(t, s.base, rateBp);
    interest += rcf * allInRate({ type: "float", rate: s.rcf.margin }, s.base, rateBp);
    interest += Math.max(0, s.rcf.commit - rcf) * COMMITMENT_FEE;

    const taxes = Math.max(0, ebitda - s.da - interest) * s.tax / 100;
    const fcf = ebitda - interest - taxes - s.capex - s.nwc;

    // scheduled amortisation, then maturities
    let amort = 0, maturing = 0, refinanced = 0;
    for (const t of tr) {
      if (t.bal <= 0) continue;
      if (t.maturity === year) {
        maturing += t.bal;
        if (stress.refiOpen) { refinanced += t.bal; t.maturity += 5; } // rolled on the same terms
        else { t.bal = 0; }
        continue;
      }
      if (t.maturity > year) {
        const a = Math.min(t.bal, t.orig * (t.amort || 0) / 100);
        t.bal -= a; amort += a;
      }
    }
    let rcfMaturing = 0;
    if (s.rcf.maturity === year && !stress.refiOpen) { rcfMaturing = rcf; rcf = 0; }

    cash += fcf - amort - (maturing - refinanced) - rcfMaturing;

    // fund any shortfall below minimum cash from the revolver, if it is still there
    let shortfall = 0;
    if (cash < s.minCash) {
      const need = s.minCash - cash;
      const room = rcfAvail ? Math.max(0, s.rcf.commit - rcf) : 0;
      const draw = Math.min(need, room);
      rcf += draw; cash += draw;
      if (cash < s.minCash - 1e-9) { shortfall = s.minCash - cash; }
    } else if (sweep > 0) {
      // sweep excess cash: revolver first, then the cheapest-to-call senior floating debt
      let excess = (cash - s.minCash) * sweep;
      const payR = Math.min(excess, rcf); rcf -= payR; cash -= payR; excess -= payR;
      for (const t of tr.filter((x) => x.type === "float" && x.bal > 0).sort((a, b) => a.rank - b.rank)) {
        if (excess <= 0) break;
        const p = Math.min(excess, t.bal); t.bal -= p; cash -= p; excess -= p;
      }
    }
    shortfallTotal += shortfall;

    const debt = tr.reduce((a, t) => a + t.bal, 0) + rcf;
    const netDebt = debt - Math.max(0, cash);
    const netLev = ebitda > 0 ? netDebt / ebitda : Infinity;
    const coverage = interest > 0 ? ebitda / interest : Infinity;
    const liquidity = Math.max(0, cash) + (rcfAvail ? Math.max(0, s.rcf.commit - rcf) : 0);
    const levBreach = netLev > s.cov.maxLev;
    const covBreach = coverage < s.cov.minCov;
    out.push({
      year, ebitda, interest, taxes, fcf, amort, maturing, refinanced, rcf, cash, debt, netDebt,
      netLev, coverage, liquidity, shortfall,
      levHeadroom: s.cov.maxLev > 0 ? (s.cov.maxLev - netLev) / s.cov.maxLev : 0,
      covHeadroom: s.cov.minCov > 0 ? (coverage - s.cov.minCov) / s.cov.minCov : 0,
      levBreach, covBreach, breach: levBreach || covBreach || shortfall > 0,
    });
  }
  const firstBreach = out.find((r) => r.breach);
  return {
    years: out,
    firstBreach: firstBreach ? firstBreach.year : null,
    firstBreachReason: firstBreach ? (firstBreach.shortfall > 0 ? "liquidity" : firstBreach.levBreach ? "leverage" : "coverage") : null,
    minLiquidity: Math.min(...out.map((r) => r.liquidity)),
    minLevHeadroom: Math.min(...out.map((r) => r.levHeadroom)),
    shortfallTotal,
  };
}

/** EBITDA decline (as a positive %) that takes today's net leverage to the covenant. */
export function ebitdaCushion(s) {
  const snap = snapshot(s);
  if (s.cov.maxLev <= 0 || s.ebitda <= 0) return 0;
  const breakEven = snap.netDebt / s.cov.maxLev;
  return (1 - breakEven / s.ebitda) * 100;
}

/** Grid of year-1 net leverage under EBITDA x rate shocks. */
export function stressGrid(s, base, ebitdaShocks, rateShocks) {
  return ebitdaShocks.map((e) => rateShocks.map((r) => {
    const p = project(s, { ...base, ebitdaShock: e, rateShockBp: r }, 1).years[0];
    return { e, r, netLev: p.netLev, coverage: p.coverage, breach: p.breach, levBreach: p.levBreach, covBreach: p.covBreach };
  }));
}

/** Debt maturing per calendar year, split by instrument. */
export function maturityWall(s, assumeRcfFull = false) {
  const items = [];
  const rcfAmt = assumeRcfFull ? s.rcf.commit : Math.min(s.rcf.drawn, s.rcf.commit);
  if (rcfAmt > 0) items.push({ name: assumeRcfFull ? "Revolver (commitment)" : "Revolver (drawn)", year: s.rcf.maturity, amount: rcfAmt, rank: 1 });
  for (const t of s.tranches) {
    // scheduled amortisation lands in each year before maturity
    let bal = t.amount;
    for (let y = s.year + 1; y < t.maturity && bal > 0; y++) {
      const a = Math.min(bal, t.amount * (t.amort || 0) / 100);
      if (a > 0) items.push({ name: t.name + " (amort.)", year: y, amount: a, rank: t.rank, amort: true, parent: t.name });
      bal -= a;
    }
    if (bal > 0) items.push({ name: t.name, year: t.maturity, amount: bal, rank: t.rank });
  }
  const years = [...new Set(items.map((i) => i.year))].sort((a, b) => a - b);
  const byYear = years.map((y) => ({ year: y, total: items.filter((i) => i.year === y).reduce((a, i) => a + i.amount, 0) }));
  const within24 = items.filter((i) => i.year <= s.year + 2).reduce((a, i) => a + i.amount, 0);
  return { items, years, byYear, within24 };
}

/**
 * Absolute-priority recovery waterfall.
 * opts = { ebitda, multiple, adminPct, rcfFull }
 * Classes are grouped by rank; tranches within a class share pro rata.
 */
export function recovery(s, opts) {
  const ev = Math.max(0, opts.ebitda * opts.multiple);
  const admin = ev * (opts.adminPct || 0) / 100;
  let left = ev - admin;
  const rcfClaim = opts.rcfFull ? s.rcf.commit : Math.min(s.rcf.drawn, s.rcf.commit);
  const claims = [];
  if (rcfClaim > 0) claims.push({ name: "Revolver", rank: 1, claim: rcfClaim });
  for (const t of s.tranches) claims.push({ name: t.name, rank: t.rank, claim: t.amount });

  const ranks = [...new Set(claims.map((c) => c.rank))].sort((a, b) => a - b);
  const classes = [];
  let fulcrum = null;
  for (const r of ranks) {
    const members = claims.filter((c) => c.rank === r);
    const total = members.reduce((a, c) => a + c.claim, 0);
    const paid = Math.min(Math.max(0, left), total);
    const pct = total > 0 ? paid / total : 0;
    left -= paid;
    if (fulcrum === null && pct < 0.999) fulcrum = r;
    classes.push({
      rank: r, label: RANKS[r], total, paid, pct,
      members: members.map((m) => ({ ...m, recovered: m.claim * pct, pct })),
    });
  }
  const equity = Math.max(0, left);
  return { ev, admin, classes, equity, fulcrum, fulcrumLabel: fulcrum ? RANKS[fulcrum] : "Equity (all debt covered)" };
}

export function recoveryBucket(pct) {
  if (pct >= 0.9) return ["Full", "good"];
  if (pct >= 0.5) return ["Partial", "warn"];
  if (pct > 0.1) return ["Impaired", "bad"];
  return ["Wiped out", "bad"];
}
