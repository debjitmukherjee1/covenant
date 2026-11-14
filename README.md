# Covenant — Credit Stress Tester

Build a company's debt stack, then break it. A leveraged-finance toolkit that
runs entirely in the browser.

- **Structure** — operating profile, revolver, maintenance covenants and an editable debt stack; cap table with all-in rates, interest and leverage through each tranche; a leverage ladder; an indicative credit band (a teaching heuristic, not a rating).
- **Stress** — EBITDA shock, base-rate shock, growth, cash sweep and an open/shut refinancing market drive a five-year projection with covenant tests and liquidity; a year-one breach grid across EBITDA × rate shocks.
- **Maturities** — the maturity wall including amortisation, debt due inside 24 months against liquidity.
- **Recovery** — distressed EV, absolute-priority waterfall, recovery by tranche and the fulcrum security.

Three invented presets (sponsor buyout, investment grade, stressed retailer). Every scenario is encoded in the URL, so a copied link reproduces it.

> Part of the zero-cost finance suite alongside Meridian, MarketPulse, Ledger, Abacus, Tenline, Tenor and Redline.

## Cost: $0/day
No data, no pipeline, no API calls. All maths is in `js/model.js` (pure functions), tested in `tests/model.test.mjs`.

## Run it locally
```bash
python3 -m http.server 8000      # open http://localhost:8000
node --test tests/               # 8 model tests
```

Personal, educational tool — not investment or credit advice, not a credit rating, not SEBI-registered research.
