# Cyprus 60-day Calculator

Russian-language client-side calculator for the Cyprus tax residency "60-day rule". Deterministic JavaScript only — no LLM is used for math.

## Files

- `index.html` — Russian UI: settings, trip rows, KPI cards, country breakdown, warnings, disclaimer, source links.
- `calc.js` — deterministic calculation engine (ported from the approved n8n workflow spec). Also exports 5 sample scenarios.
- `app.js` — UI controller: row management, sample loaders, render pipeline.
- `styles.css` — Mediterranean limestone-and-teal palette, mobile-responsive, accessible contrast.

## Run locally

```bash
cd cyprus-60-day-calculator
python3 -m http.server 5050
# open http://localhost:5050/
```

No build step. No backend. No dependencies — fonts are loaded from Google Fonts CDN; everything else is vanilla HTML/CSS/JS.

## Deployment

Static bundle ready for `deploy_website(project_path="/home/user/workspace/cyprus-60-day-calculator", entry_point="index.html")`.

## Test results

All five required sample scenarios match the spec's expected outputs:

| Scenario | Cyprus days | Other > 183 | Max other | Status | Result |
|---|---:|---|---|---|---|
| Exactly 60 days on Cyprus | 60 | нет | none | likely qualifies | ✅ |
| 59 days on Cyprus | 59 | нет | none | likely does not qualify | ✅ |
| Other country > 183 days | 60 | да | Russia, 185 | likely does not qualify | ✅ |
| Transit days | 60 | нет | none | likely qualifies (+transit warning) | ✅ |
| Multiple countries | 60 | нет | Greece, 30 | likely qualifies | ✅ |

Validation also verified manually via Playwright:
- Empty country → `missing_required_field` + `unknown_country` errors rendered in Russian.
- Departure before arrival → `departure_before_arrival` error rendered in Russian.
- Cyrillic country name «Кипр» normalizes to `Cyprus` and counts 60 days.
- `has_cyprus_home = unknown` flips status to `needs tax advisor review`.

Mobile layout verified at 375px viewport: single-column flow, KPI cards stack, trips table scrolls horizontally.

## Sources cited in UI

- [PwC Worldwide Tax Summaries — Cyprus, Individual Residence](https://taxsummaries.pwc.com/cyprus/individual/residence)
- [Constantinos Markou & Co — Cyprus Tax Residency](https://www.cmarkou.com/tax/cyprus-tax-residency/)

## Known limitations

- The country alias list covers ~35 common countries; unknown country strings pass through verbatim (no error unless empty).
- Date inputs use the native browser `<input type="date">` widget, which renders MM/DD/YYYY in some locales but stores ISO `YYYY-MM-DD` — the calculation always uses the ISO value.
- The calculator does not persist data between sessions (sandbox-safe; no localStorage).
- Same-day departure-and-return-to-Cyprus detection works only between separate trip rows; it does not model intra-row trips.
- The five built-in scenarios match the spec's expected outputs exactly; broader edge cases (e.g., trips spanning the year boundary, leap years) inherit the spec's behavior — both `yearStart` and `yearEnd` clip the period to the tax year.

## Legal disclaimer

The UI prominently states the calculator is **not legal or tax advice**. Both source URLs are linked in the disclaimer section.
