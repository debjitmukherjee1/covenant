// Covenant — app.js: state, inputs, rendering. All maths is in model.js.
import { RANKS, snapshot, creditBand, project, ebitdaCushion, stressGrid, maturityWall, recovery, recoveryBucket } from "./model.js";
import { fromPreset, SCENARIOS } from "./presets.js";

const YEAR = new Date().getFullYear();
const $ = (id) => document.getElementById(id);
const COLORS = ["#f3f3f1", "#8f7dff", "#1fd8c4", "#f2c14e", "#ff6a4a", "#7aa7ff", "#c49bff", "#9be38a"];
const RANK_COLOR = { 1: "#f3f3f1", 2: "#8f7dff", 3: "#1fd8c4", 4: "#f2c14e" };
const GRID = "rgba(255,255,255,.06)";

let S;                       // model state
let stress = { ebitdaShock: 0, rateShockBp: 0, growth: null, sweep: 50, refiOpen: true };
let rec = { pct: 70, mult: 6, admin: 5, rcfFull: true };
let wallFull = false;
let preset = "lbo";
const charts = {};
const dirty = { structure: true, stress: true, maturities: true, recovery: true };

// ---------- formatting ------------------------------------------------------
const nf0 = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
const amt = (v) => (v == null || !isFinite(v) ? "—" : (v < 0 ? "−" : "") + nf0.format(Math.abs(Math.round(v))));
const units = () => S.units || "";
const xx = (v, d = 1) => (v == null ? "—" : !isFinite(v) ? "n/m" : v < 0 ? "net cash" : v.toFixed(d) + "x");
const pct = (v, d = 1) => (v == null || !isFinite(v) ? "—" : v.toFixed(d) + "%");
const signed = (v, d = 0, suf = "") => (v > 0 ? "+" : v < 0 ? "−" : "") + Math.abs(v).toFixed(d) + suf;
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const kpi = (label, value, unit, sub, cls = "") =>
  `<div class="kpi"><span class="label">${label}</span><div class="value ${cls}">${value}${unit ? `<small>${esc(unit)}</small>` : ""}</div><div class="sub">${sub || "&nbsp;"}</div></div>`;
const chip = (text, tone) => `<span class="chip ${tone}">${text}</span>`;

// ---------- state <-> URL ---------------------------------------------------
function encode() {
  const json = JSON.stringify({ v: 1, p: preset, S, stress, rec });
  return btoa(unescape(encodeURIComponent(json))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
// A shared link is untrusted input: keep only plain numbers, short plain text
// and booleans, drop anything else (red-team finding, 23-Nov-2026).
function clean(v, depth = 0) {
  if (depth > 6) return undefined;
  if (typeof v === "number") return Number.isFinite(v) ? v : 0;
  if (typeof v === "boolean" || v === null) return v;
  if (typeof v === "string") return v.replace(/[<>"'`&\\]/g, "").slice(0, 60);
  if (Array.isArray(v)) return v.slice(0, 40).map((x) => clean(x, depth + 1));
  if (typeof v === "object") {
    const out = {};
    for (const k of Object.keys(v).slice(0, 60)) {
      if (k === "__proto__" || k === "constructor" || k === "prototype") continue;
      out[k] = clean(v[k], depth + 1);
    }
    return out;
  }
  return undefined;
}
function decode(str) {
  try {
    const b = str.replace(/-/g, "+").replace(/_/g, "/");
    const o = JSON.parse(decodeURIComponent(escape(atob(b))));
    if (!o || !o.S || !Array.isArray(o.S.tranches)) return null;
    return clean(o);
  } catch { return null; }
}
let urlTimer;
function syncUrl() {
  clearTimeout(urlTimer);
  urlTimer = setTimeout(() => {
    const u = new URL(location.href);
    u.searchParams.set("s", encode());
    history.replaceState(null, "", u.pathname + "?" + u.searchParams.toString() + location.hash);
  }, 250);
}

// ---------- field definitions ----------------------------------------------
const OP_FIELDS = [
  ["ebitda", "LTM EBITDA", 1], ["da", "D&A", 1], ["capex", "Capex", 1], ["nwc", "Working capital and other", 1],
  ["tax", "Cash tax rate (%)", 0.5], ["growth", "EBITDA growth (% / yr)", 0.5], ["cash", "Cash", 1], ["minCash", "Minimum cash", 1],
  ["base", "Base rate, SOFR (%)", 0.05], ["year", "Model year", 1],
];
const RCF_FIELDS = [["rcf.commit", "Commitment", 1], ["rcf.drawn", "Drawn", 1], ["rcf.margin", "Margin over base (%)", 0.125], ["rcf.maturity", "Maturity (year)", 1]];
const COV_FIELDS = [["cov.maxLev", "Max net leverage (x)", 0.25], ["cov.minCov", "Min interest cover (x)", 0.25]];

const getPath = (o, p) => p.split(".").reduce((a, k) => a[k], o);
const setPath = (o, p, v) => { const ks = p.split("."); const last = ks.pop(); ks.reduce((a, k) => a[k], o)[last] = v; };

function buildFields(containerId, defs) {
  $(containerId).innerHTML = defs.map(([k, label, step]) => {
    const id = "f-" + k.replace(".", "-");
    const isAmt = !/%|\(x\)|year/i.test(label);
    return `<div class="field"><label class="label" for="${id}">${label}${isAmt ? ` <span class="unit-tag">${esc(units())}</span>` : ""}</label>
      <input type="number" id="${id}" data-path="${k}" step="${step}" inputmode="decimal" value="${getPath(S, k)}"></div>`;
  }).join("");
}
function refreshFieldValues() {
  document.querySelectorAll("[data-path]").forEach((inp) => { inp.value = getPath(S, inp.dataset.path); });
  document.querySelectorAll(".unit-tag").forEach((t) => { t.textContent = units(); });
}

function buildStackEditor() {
  const head = `<thead><tr><th>Tranche</th><th>Ranking</th><th>Amount</th><th>Rate</th><th>Type</th><th>Maturity</th><th>Amort. %/yr</th><th></th></tr></thead>`;
  const rows = S.tranches.map((t, i) => `<tr data-i="${i}">
      <td><input type="text" data-k="name" value="${esc(t.name)}" aria-label="Tranche name" maxlength="40"></td>
      <td><select data-k="rank" aria-label="Ranking">${Object.entries(RANKS).map(([r, l]) => `<option value="${r}" ${+r === t.rank ? "selected" : ""}>${l}</option>`).join("")}</select></td>
      <td><input type="number" data-k="amount" value="${t.amount}" step="1" min="0" aria-label="Amount"></td>
      <td><input type="number" data-k="rate" value="${t.rate}" step="0.125" aria-label="${t.type === "float" ? "Spread over base (%)" : "Coupon (%)"}"></td>
      <td><select data-k="type" aria-label="Rate type"><option value="float" ${t.type === "float" ? "selected" : ""}>Float</option><option value="fixed" ${t.type === "fixed" ? "selected" : ""}>Fixed</option></select></td>
      <td><input type="number" data-k="maturity" value="${t.maturity}" step="1" aria-label="Maturity year"></td>
      <td><input type="number" data-k="amort" value="${t.amort}" step="0.5" min="0" aria-label="Amortisation"></td>
      <td><button class="icon-btn" data-remove="${i}" aria-label="Remove ${esc(t.name)}" ${S.tranches.length <= 1 ? "disabled" : ""}>
        <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M2 2l8 8M10 2l-8 8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg></button></td>
    </tr>`).join("");
  $("stack-edit").innerHTML = head + "<tbody>" + rows + "</tbody>";
}

// ---------- structure --------------------------------------------------------
function renderStructure() {
  const snap = snapshot(S);
  const band = creditBand(snap.netLev, snap.coverage);
  const levHead = S.cov.maxLev > 0 ? (S.cov.maxLev - snap.netLev) / S.cov.maxLev * 100 : 0;
  const covHead = S.cov.minCov > 0 ? (snap.coverage - S.cov.minCov) / S.cov.minCov * 100 : 0;
  const tone = band.investmentGrade ? "good" : band.band === "BB" || band.band === "B" ? "warn" : "bad";
  $("struct-kpis").innerHTML =
    kpi("Net leverage", xx(snap.netLev), "", `covenant ${xx(S.cov.maxLev, 2)} · ${levHead >= 0 ? pct(levHead, 0) + " headroom" : "in breach"}`) +
    kpi("Interest cover", xx(snap.coverage), "", `covenant ${xx(S.cov.minCov, 2)} · ${covHead >= 0 ? pct(covHead, 0) + " headroom" : "in breach"}`) +
    kpi("Liquidity", amt(snap.liquidity), units(), `cash plus undrawn revolver`) +
    kpi("Indicative band", chip(band.band, tone), "", `leverage says ${band.fromLeverage}, cover says ${band.fromCoverage}`, "value--chip");

  // cap table
  let h = `<thead><tr><th>Tranche</th><th>Ranking</th><th>Amount</th><th>All-in rate</th><th>Interest</th><th>Through</th><th>Maturity</th></tr></thead><tbody>`;
  snap.rows.forEach((r) => {
    h += `<tr><td><span class="dot" style="background:${RANK_COLOR[r.rank]}"></span> ${esc(r.name)}</td><td>${RANKS[r.rank]}</td><td>${amt(r.amount)}</td>
      <td>${pct(r.allIn * 100, 2)}</td><td>${amt(r.interest)}</td><td>${xx(r.cumLev)}</td><td>${r.maturity}</td></tr>`;
  });
  h += `<tr class="total"><td>Total debt</td><td></td><td>${amt(snap.debt)}</td><td>${pct(snap.costOfDebt * 100, 2)}</td><td>${amt(snap.interest)}</td><td>${xx(snap.grossLev)}</td><td>${snap.wam.toFixed(1)} yrs avg</td></tr>`;
  h += `<tr><td>Less cash</td><td></td><td>${amt(-S.cash)}</td><td></td><td></td><td></td><td></td></tr>`;
  h += `<tr class="total"><td>Net debt</td><td></td><td>${amt(snap.netDebt)}</td><td></td><td></td><td>${xx(snap.netLev)}</td><td></td></tr></tbody>`;
  $("cap-table").innerHTML = h;

  // ladder
  const total = snap.grossLev;
  const covGross = S.cov.maxLev + (S.ebitda > 0 ? S.cash / S.ebitda : 0);
  const scale = Math.max(total, covGross, 1) * 1.08;
  let cum = 0;
  $("ladder").innerHTML = snap.rows.map((r) => {
    const w = (r.amount / S.ebitda) / scale * 100;
    cum += r.amount / S.ebitda;
    return `<div class="seg-bar" style="width:${w}%;--c:${RANK_COLOR[r.rank]}" title="${esc(r.name)}: ${xx(r.amount / S.ebitda)}">${w >= 7 ? `<span>${xx(cum)}</span>` : ""}</div>`;
  }).join("") + `<div class="cov-mark" style="left:${covGross / scale * 100}%"><span>covenant, gross of cash ${xx(covGross)}</span></div>`;
  $("ladder-legend").innerHTML = snap.rows.map((r) =>
    `<span><span class="dot" style="background:${RANK_COLOR[r.rank]}"></span>${esc(r.name)} · ${amt(r.amount)} ${esc(units())}</span>`).join("");
}

// ---------- stress -----------------------------------------------------------
function stressNow() { return { ...stress, growth: stress.growth ?? S.growth }; }

function renderStress() {
  const st = stressNow();
  const p = project(S, st);
  const cushion = ebitdaCushion(S);
  $("stress-kpis").innerHTML =
    kpi("EBITDA cushion", cushion >= 0 ? pct(cushion, 0) : "none", "", "fall in today's EBITDA before the leverage test fails") +
    kpi("First breach", p.firstBreach ? String(p.firstBreach) : "None", "", p.firstBreach ? `${p.firstBreachReason} test fails first` : "in the five years projected", p.firstBreach ? "neg" : "") +
    kpi("Lowest liquidity", amt(p.minLiquidity), units(), p.shortfallTotal > 0 ? `<span class="neg">shortfall ${amt(p.shortfallTotal)} ${esc(units())}</span>` : "cash plus available revolver") +
    kpi("Tightest headroom", pct(p.minLevHeadroom * 100, 0), "", "leverage test, worst year");

  // projection table
  const ys = p.years;
  const row = (label, f, cls) => `<tr${cls ? ` class="${cls}"` : ""}><td>${label}</td>${ys.map((y) => `<td>${f(y)}</td>`).join("")}</tr>`;
  $("proj-table").innerHTML = `<thead><tr><th>Year</th>${ys.map((y) => `<th>${y.year}</th>`).join("")}</tr></thead><tbody>` +
    row("EBITDA", (y) => amt(y.ebitda)) +
    row("Cash interest", (y) => amt(y.interest)) +
    row("Cash tax", (y) => amt(y.taxes)) +
    row("Free cash flow", (y) => `<span class="${y.fcf < 0 ? "neg" : ""}">${amt(y.fcf)}</span>`) +
    row("Scheduled amortisation", (y) => amt(y.amort)) +
    row("Maturing", (y) => (y.maturing ? amt(y.maturing) + (y.refinanced ? " rolled" : " repaid") : "—")) +
    row("Revolver drawn", (y) => amt(y.rcf)) +
    row("Cash", (y) => amt(y.cash)) +
    row("Total debt", (y) => amt(y.debt), "total") +
    row("Net leverage", (y) => `<span class="${y.levBreach ? "neg" : ""}">${xx(y.netLev)}</span>`) +
    row("Interest cover", (y) => `<span class="${y.covBreach ? "neg" : ""}">${xx(y.coverage)}</span>`) +
    row("Liquidity", (y) => amt(y.liquidity)) +
    row("Status", (y) => (y.breach ? chip(y.shortfall > 0 ? "Shortfall" : "Breach", "bad") : y.levHeadroom < 0.15 || y.covHeadroom < 0.15 ? chip("Tight", "warn") : chip("Pass", "good"))) +
    "</tbody>";
  $("proj-units").textContent = units() ? `${units()} unless stated` : "";

  // charts
  const labels = ys.map((y) => String(y.year));
  const levColors = ys.map((y) => (y.levBreach ? "rgba(255,106,74,.85)" : y.levHeadroom < 0.15 ? "rgba(242,193,78,.8)" : "rgba(243,243,241,.82)"));
  const cfgLev = {
    type: "bar",
    data: { labels, datasets: [
      { type: "bar", label: "Net leverage", data: ys.map((y) => (isFinite(y.netLev) ? +y.netLev.toFixed(2) : null)), backgroundColor: levColors, borderRadius: 8, maxBarThickness: 46, order: 2 },
      { type: "line", label: "Covenant max", data: ys.map(() => S.cov.maxLev), borderColor: "#ff6a4a", borderDash: [6, 5], borderWidth: 1.5, pointRadius: 0, order: 1 },
    ] },
    options: chartOpts((v) => v.toFixed(1) + "x", (c) => ` ${c.dataset.label}  ${c.parsed.y.toFixed(2)}x`),
  };
  const cfgCov = {
    type: "bar",
    data: { labels, datasets: [
      { type: "bar", label: "Liquidity", data: ys.map((y) => Math.round(y.liquidity)), backgroundColor: "rgba(143,125,255,.28)", borderRadius: 8, maxBarThickness: 46, yAxisID: "y1", order: 3 },
      { type: "line", label: "Interest cover", data: ys.map((y) => (isFinite(y.coverage) ? +y.coverage.toFixed(2) : null)), borderColor: "#1fd8c4", backgroundColor: "#1fd8c4", borderWidth: 2, pointRadius: 3, tension: .3, yAxisID: "y", order: 1 },
      { type: "line", label: "Cover minimum", data: ys.map(() => S.cov.minCov), borderColor: "#ff6a4a", borderDash: [6, 5], borderWidth: 1.5, pointRadius: 0, yAxisID: "y", order: 2 },
    ] },
    options: (() => {
      const o = chartOpts((v) => v.toFixed(1) + "x", (c) => (c.dataset.yAxisID === "y1" ? ` Liquidity  ${amt(c.parsed.y)} ${units()}` : ` ${c.dataset.label}  ${c.parsed.y.toFixed(2)}x`));
      o.scales.y1 = { position: "right", grid: { display: false }, border: { display: false }, ticks: { callback: (v) => amt(v) } };
      o.plugins.legend = { display: true, position: "bottom", align: "start", labels: { boxWidth: 14, boxHeight: 2, padding: 14 } };
      return o;
    })(),
  };
  upsert("lev", "lev-chart", cfgLev);
  upsert("cov", "cov-chart", cfgCov);

  // breach grid
  const eShocks = [0, -10, -20, -30, -40, -50];
  const rShocks = [0, 100, 200, 300, 400];
  const grid = stressGrid(S, st, eShocks, rShocks);
  let g = `<thead><tr><th>EBITDA \\ rates</th>${rShocks.map((r) => `<th>${signed(r, 0, " bp")}</th>`).join("")}</tr></thead><tbody>`;
  grid.forEach((row, i) => {
    g += `<tr><td>${eShocks[i] === 0 ? "Unchanged" : signed(eShocks[i], 0, "%")}</td>` + row.map((c) => {
      const head = (S.cov.maxLev - c.netLev) / S.cov.maxLev;
      const tone = c.breach ? "bad" : head < 0.15 || (c.coverage - S.cov.minCov) / S.cov.minCov < 0.15 ? "warn" : "good";
      const why = c.levBreach ? "leverage" : c.covBreach ? "cover" : c.breach ? "liquidity" : "";
      return `<td class="cell-${tone}" title="${why ? why + " test fails" : "passes"} · cover ${xx(c.coverage)}">${xx(c.netLev)}${why ? `<small>${why}</small>` : ""}</td>`;
    }).join("") + "</tr>";
  });
  $("heat").innerHTML = g + "</tbody>";
}

function chartOpts(yfmt, label) {
  return {
    responsive: true, maintainAspectRatio: false, animation: { duration: 450, easing: "easeOutQuart" },
    interaction: { mode: "index", intersect: false },
    plugins: { legend: { display: false }, tooltip: { callbacks: { label } } },
    scales: {
      x: { grid: { display: false }, border: { display: false } },
      y: { beginAtZero: true, grid: { color: GRID, drawTicks: false }, border: { display: false }, ticks: { padding: 8, callback: yfmt } },
    },
  };
}
function upsert(key, canvasId, cfg) {
  const c = charts[key];
  if (c && c.config.type === cfg.type && c.data.datasets.length === cfg.data.datasets.length) {
    c.data.labels = cfg.data.labels;
    cfg.data.datasets.forEach((d, i) => Object.assign(c.data.datasets[i], d));
    c.options = cfg.options;
    c.update();
    return;
  }
  if (c) c.destroy();
  charts[key] = new Chart($(canvasId), cfg);
}

// ---------- maturities --------------------------------------------------------
function renderMaturities() {
  const w = maturityWall(S, wallFull);
  const snap = snapshot(S);
  const cover = w.within24 > 0 ? snap.liquidity / w.within24 : Infinity;
  const peak = w.byYear.reduce((a, b) => (b.total > a.total ? b : a), { year: "—", total: 0 });
  $("mat-kpis").innerHTML =
    kpi("Due within 24 months", amt(w.within24), units(), `through ${S.year + 2}, incl. amortisation`) +
    kpi("Liquidity today", amt(snap.liquidity), units(), "cash plus undrawn revolver") +
    kpi("Liquidity cover", isFinite(cover) ? cover.toFixed(1) + "x" : "n/m", "", isFinite(cover) && cover < 1 ? '<span class="neg">cannot meet near maturities unaided</span>' : "liquidity ÷ near-term maturities", isFinite(cover) && cover < 1 ? "neg" : "") +
    kpi("Peak year", String(peak.year), "", `${amt(peak.total)} ${esc(units())} due`);

  const from = S.year + 1;
  const to = Math.max(from + 6, ...w.years);
  const labels = [];
  for (let y = from; y <= to; y++) labels.push(String(y));
  const names = [];
  w.items.forEach((i) => { const n = i.parent || i.name; if (!names.includes(n)) names.push(n); });
  const datasets = names.map((n, k) => ({
    label: n,
    data: labels.map((y) => Math.round(w.items.filter((i) => (i.parent || i.name) === n && String(i.year) === y).reduce((a, i) => a + i.amount, 0)) || null),
    backgroundColor: COLORS[k % COLORS.length] + (k === 0 ? "d9" : "cc"),
    borderRadius: 6, maxBarThickness: 52, stack: "s",
  }));
  const o = chartOpts((v) => amt(v), (c) => ` ${c.dataset.label}  ${amt(c.parsed.y)} ${units()}`);
  o.scales.x.stacked = true; o.scales.y.stacked = true;
  o.plugins.legend = { display: true, position: "bottom", align: "start", labels: { boxWidth: 12, boxHeight: 12, padding: 14 } };
  if (charts.wall) charts.wall.destroy();
  charts.wall = new Chart($("wall-chart"), { type: "bar", data: { labels, datasets }, options: o });

  let h = `<thead><tr><th>Instrument</th><th>Year</th><th>Amount</th><th>Ranking</th><th>Kind</th></tr></thead><tbody>`;
  [...w.items].sort((a, b) => a.year - b.year || a.rank - b.rank).forEach((i) => {
    const near = i.year <= S.year + 2;
    h += `<tr><td>${esc(i.parent || i.name)}</td><td>${near ? `<span class="neg">${i.year}</span>` : i.year}</td><td>${amt(i.amount)}</td><td>${RANKS[i.rank]}</td><td>${i.amort ? "Amortisation" : "Bullet"}</td></tr>`;
  });
  $("wall-table").innerHTML = h + "</tbody>";
}

// ---------- recovery -----------------------------------------------------------
function renderRecovery() {
  const r = recovery(S, { ebitda: S.ebitda * rec.pct / 100, multiple: rec.mult, adminPct: rec.admin, rcfFull: rec.rcfFull });
  const byRank = (k) => r.classes.find((c) => c.rank === k);
  const first = byRank(1), uns = byRank(3);
  $("rec-kpis").innerHTML =
    kpi("Distressed EV", amt(r.ev), units(), `${amt(S.ebitda * rec.pct / 100)} EBITDA × ${rec.mult.toFixed(2)}x`) +
    kpi("Fulcrum", `<span class="fulcrum">${r.fulcrum ? RANKS[r.fulcrum] : "None"}</span>`, "", r.fulcrum ? "most senior class not paid in full" : "all debt recovers in full", "value--text") +
    kpi("First lien recovery", first ? pct(first.pct * 100, 0) : "—", "", first ? "incl. revolver" : "no first lien debt") +
    kpi("Unsecured recovery", uns ? pct(uns.pct * 100, 0) : "—", "", r.equity > 0 ? `residual to equity ${amt(r.equity)}` : "equity receives nothing");

  // waterfall bars
  const maxClaim = Math.max(r.ev, ...r.classes.map((c) => c.total), 1);
  const bar = (label, total, paid, color, note) => {
    const pw = total > 0 ? paid / maxClaim * 100 : 0;
    const tw = total / maxClaim * 100;
    return `<div class="wf-row"><div class="wf-label"><span>${label}</span><span class="mono">${note}</span></div>
      <div class="wf-track"><div class="wf-claim" style="width:${tw}%"></div><div class="wf-paid" style="width:${pw}%;--c:${color}"></div></div></div>`;
  };
  let html = bar("Distressed enterprise value", r.ev, r.ev, "rgba(243,243,241,.9)", `${amt(r.ev)} ${esc(units())}`);
  html += bar("Administrative claims", r.admin, r.admin, "rgba(143,145,153,.7)", amt(r.admin));
  r.classes.forEach((c) => {
    const [txt] = recoveryBucket(c.pct);
    html += bar(`${c.label}${r.fulcrum === c.rank ? ' <span class="chip warn chip-xs">fulcrum</span>' : ""}`, c.total, c.paid, RANK_COLOR[c.rank], `${amt(c.paid)} of ${amt(c.total)} · ${pct(c.pct * 100, 0)} · ${txt.toLowerCase()}`);
  });
  html += bar("Equity", Math.max(r.equity, 0), r.equity, "#9be38a", r.equity > 0 ? amt(r.equity) : "nothing left");
  $("waterfall").innerHTML = html;

  let h = `<thead><tr><th>Tranche</th><th>Ranking</th><th>Claim</th><th>Recovered</th><th>Recovery</th><th>Outcome</th></tr></thead><tbody>`;
  r.classes.forEach((c) => c.members.forEach((m) => {
    const [txt, tone] = recoveryBucket(m.pct);
    h += `<tr><td>${esc(m.name)}</td><td>${RANKS[m.rank]}</td><td>${amt(m.claim)}</td><td>${amt(m.recovered)}</td><td>${pct(m.pct * 100, 0)}</td><td>${chip(txt, tone)}</td></tr>`;
  }));
  $("rec-table").innerHTML = h + "</tbody>";
}

// ---------- orchestration --------------------------------------------------------
const RENDER = { structure: renderStructure, stress: renderStress, maturities: renderMaturities, recovery: renderRecovery };
function activePanel() { const p = document.querySelector(".panel.active"); return p ? p.id : "structure"; }
function renderAll() {
  Object.keys(dirty).forEach((k) => { dirty[k] = true; });
  const a = activePanel();
  if (RENDER[a]) { RENDER[a](); dirty[a] = false; }
  syncUrl();
}
document.addEventListener("tabchange", (e) => {
  const n = e.detail;
  if (RENDER[n] && dirty[n]) { RENDER[n](); dirty[n] = false; }
  Object.values(charts).forEach((c) => { if (c.canvas.closest(".panel.active")) c.resize(); });
});

function markCustom() {
  if (preset !== "custom") { preset = "custom"; $("preset").value = "custom"; }
}

function syncStressControls() {
  const st = stressNow();
  $("s-ebitda").value = st.ebitdaShock; $("o-ebitda").textContent = signed(st.ebitdaShock, 0, "%");
  $("s-rate").value = st.rateShockBp; $("o-rate").textContent = signed(st.rateShockBp, 0, " bp");
  $("s-growth").value = st.growth; $("o-growth").textContent = signed(st.growth, 1, "%");
  $("s-sweep").value = st.sweep; $("o-sweep").textContent = st.sweep + "%";
  document.querySelectorAll("#refi-toggle button").forEach((b) => { const on = (b.dataset.refi === "1") === st.refiOpen; b.classList.toggle("active", on); b.setAttribute("aria-pressed", String(on)); });
  $("r-ebitda").value = rec.pct; $("o-rebitda").textContent = rec.pct + "%";
  $("r-mult").value = rec.mult; $("o-rmult").textContent = rec.mult.toFixed(2) + "x";
  $("r-admin").value = rec.admin; $("o-radmin").textContent = rec.admin + "% of EV";
  document.querySelectorAll("#rec-rcf button").forEach((b) => { const on = (b.dataset.full === "1") === rec.rcfFull; b.classList.toggle("active", on); b.setAttribute("aria-pressed", String(on)); });
  document.querySelectorAll("#rcf-mode button").forEach((b) => { const on = (b.dataset.full === "1") === wallFull; b.classList.toggle("active", on); b.setAttribute("aria-pressed", String(on)); });
}

function loadPreset(key) {
  preset = key;
  S = fromPreset(key, YEAR);
  stress = { ebitdaShock: 0, rateShockBp: 0, growth: null, sweep: 50, refiOpen: true };
  document.querySelectorAll("#scen-presets button").forEach((b) => b.classList.toggle("active", b.dataset.s === "base"));
  hydrate();
}

function hydrate() {
  $("preset").value = preset;
  $("co-name").value = S.name; $("co-units").value = S.units;
  buildFields("op-fields", OP_FIELDS);
  buildFields("rcf-fields", RCF_FIELDS);
  buildFields("cov-fields", COV_FIELDS);
  buildStackEditor();
  syncStressControls();
  renderAll();
}

function num(v, fallback = 0) { const n = parseFloat(v); return isFinite(n) ? n : fallback; }

function wire() {
  $("preset").addEventListener("change", (e) => { if (e.target.value !== "custom") loadPreset(e.target.value); });
  $("co-name").addEventListener("input", (e) => { S.name = e.target.value; markCustom(); syncUrl(); });
  $("co-units").addEventListener("input", (e) => { S.units = e.target.value; markCustom(); refreshFieldValues(); renderAll(); });

  document.querySelector(".inputs-grid").addEventListener("input", (e) => {
    const p = e.target.dataset.path;
    if (!p) return;
    setPath(S, p, num(e.target.value, getPath(S, p)));
    markCustom(); renderAll();
  });

  $("stack-edit").addEventListener("input", (e) => {
    const tr = e.target.closest("tr[data-i]"); const k = e.target.dataset.k;
    if (!tr || !k) return;
    const t = S.tranches[+tr.dataset.i];
    t[k] = k === "name" || k === "type" ? e.target.value : num(e.target.value, t[k]);
    if (k === "rank") t.rank = +e.target.value;
    if (k === "type") e.target.closest("tr").querySelector('[data-k="rate"]').setAttribute("aria-label", t.type === "float" ? "Spread over base (%)" : "Coupon (%)");
    markCustom(); renderAll();
  });
  $("stack-edit").addEventListener("change", (e) => { if (e.target.tagName === "SELECT") { markCustom(); renderAll(); } });
  $("stack-edit").addEventListener("click", (e) => {
    const b = e.target.closest("[data-remove]");
    if (!b || S.tranches.length <= 1) return;
    S.tranches.splice(+b.dataset.remove, 1);
    markCustom(); buildStackEditor(); renderAll();
  });
  $("add-tranche").addEventListener("click", () => {
    S.tranches.push({ name: "New tranche", rank: 3, amount: 100, type: "fixed", rate: 7.5, maturity: S.year + 5, amort: 0 });
    markCustom(); buildStackEditor(); renderAll();
    const inputs = $("stack-edit").querySelectorAll('input[data-k="name"]');
    inputs[inputs.length - 1].focus(); inputs[inputs.length - 1].select();
  });

  const slider = (id, fn) => $(id).addEventListener("input", (e) => { fn(parseFloat(e.target.value)); syncStressControls(); renderAll(); });
  const clearScen = () => document.querySelectorAll("#scen-presets button").forEach((b) => b.classList.remove("active"));
  slider("s-ebitda", (v) => { stress.ebitdaShock = v; clearScen(); });
  slider("s-rate", (v) => { stress.rateShockBp = v; clearScen(); });
  slider("s-growth", (v) => { stress.growth = v; });
  slider("s-sweep", (v) => { stress.sweep = v; });
  slider("r-ebitda", (v) => { rec.pct = v; });
  slider("r-mult", (v) => { rec.mult = v; });
  slider("r-admin", (v) => { rec.admin = v; });
  document.querySelectorAll("#refi-toggle button").forEach((b) => b.addEventListener("click", () => { stress.refiOpen = b.dataset.refi === "1"; clearScen(); syncStressControls(); renderAll(); }));
  document.querySelectorAll("#rec-rcf button").forEach((b) => b.addEventListener("click", () => { rec.rcfFull = b.dataset.full === "1"; syncStressControls(); renderAll(); }));
  document.querySelectorAll("#rcf-mode button").forEach((b) => b.addEventListener("click", () => { wallFull = b.dataset.full === "1"; syncStressControls(); renderAll(); }));
  document.querySelectorAll("#scen-presets button").forEach((b) => b.addEventListener("click", () => {
    Object.assign(stress, SCENARIOS[b.dataset.s]);
    document.querySelectorAll("#scen-presets button").forEach((x) => x.classList.toggle("active", x === b));
    syncStressControls(); renderAll();
  }));

  $("copy-link").addEventListener("click", async () => {
    const u = new URL(location.href); u.searchParams.set("s", encode());
    let ok = false;
    try { await navigator.clipboard.writeText(u.toString()); ok = true; } catch { /* clipboard blocked */ }
    $("copied").textContent = ok ? "Link copied" : "Copy the address bar";
    $("copied").classList.add("show");
    setTimeout(() => $("copied").classList.remove("show"), 1800);
  });
}

// ---------- boot ----------------------------------------------------------------
wire();
const fromUrl = new URL(location.href).searchParams.get("s");
const saved = fromUrl && decode(fromUrl);
if (saved) {
  preset = saved.p || "custom"; S = saved.S;
  if (saved.stress) stress = { ...stress, ...saved.stress };
  if (saved.rec) rec = { ...rec, ...saved.rec };
  hydrate();
} else {
  loadPreset("lbo");
}
