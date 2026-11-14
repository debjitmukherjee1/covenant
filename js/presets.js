// Covenant — presets.js
// Three invented companies, built to show three typical credit profiles.
// Maturities are stored as years-from-now so the presets never go stale.

export const PRESETS = {
  lbo: {
    name: "Harbor Logistics", units: "$m",
    ebitda: 250, da: 60, capex: 70, nwc: 10, tax: 25, growth: 4, cash: 80, minCash: 30, base: 4.3,
    rcf: { commit: 150, drawn: 20, margin: 3.25, maturity: 4 },
    cov: { maxLev: 6.5, minCov: 2.0 },
    tranches: [
      { name: "Term Loan B", rank: 1, amount: 1000, type: "float", rate: 3.75, maturity: 6, amort: 1 },
      { name: "Senior notes 8.25%", rank: 3, amount: 400, type: "fixed", rate: 8.25, maturity: 7, amort: 0 },
    ],
  },
  ig: {
    name: "Ashby Industrial", units: "$m",
    ebitda: 1200, da: 300, capex: 350, nwc: 40, tax: 24, growth: 3, cash: 400, minCash: 150, base: 4.3,
    rcf: { commit: 800, drawn: 0, margin: 1.25, maturity: 4 },
    cov: { maxLev: 3.5, minCov: 4.0 },
    tranches: [
      { name: "Term Loan A", rank: 3, amount: 500, type: "float", rate: 1.375, maturity: 3, amort: 5 },
      { name: "Notes 4.25% (short)", rank: 3, amount: 750, type: "fixed", rate: 4.25, maturity: 2, amort: 0 },
      { name: "Notes 5.10% (mid)", rank: 3, amount: 1000, type: "fixed", rate: 5.1, maturity: 5, amort: 0 },
      { name: "Notes 5.60% (long)", rank: 3, amount: 750, type: "fixed", rate: 5.6, maturity: 10, amort: 0 },
    ],
  },
  stressed: {
    name: "Corvel Retail", units: "$m",
    ebitda: 180, da: 70, capex: 60, nwc: 15, tax: 25, growth: -2, cash: 45, minCash: 25, base: 4.3,
    rcf: { commit: 200, drawn: 120, margin: 2.5, maturity: 1 },
    cov: { maxLev: 7.0, minCov: 1.5 },
    tranches: [
      { name: "First lien term loan", rank: 1, amount: 900, type: "float", rate: 4.75, maturity: 1, amort: 1 },
      { name: "Second lien term loan", rank: 2, amount: 250, type: "float", rate: 8.0, maturity: 2, amort: 0 },
      { name: "Unsecured notes 9.5%", rank: 3, amount: 300, type: "fixed", rate: 9.5, maturity: 3, amort: 0 },
    ],
  },
};

export const SCENARIOS = {
  base: { ebitdaShock: 0, rateShockBp: 0, refiOpen: true },
  recession: { ebitdaShock: -20, rateShockBp: -100, refiOpen: true },
  rates: { ebitdaShock: 0, rateShockBp: 300, refiOpen: true },
  stag: { ebitdaShock: -25, rateShockBp: 250, refiOpen: false },
};

/** Expand a preset into an absolute-year model state. */
export function fromPreset(key, year) {
  const p = JSON.parse(JSON.stringify(PRESETS[key]));
  p.year = year;
  p.rcf.maturity += year;
  p.tranches.forEach((t) => { t.maturity += year; });
  return p;
}
