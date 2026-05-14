# Cyprus 60-day Calculator — Nadya

Russian-language Cyprus tax residency "60-day rule" calculator with a small
Node + SQLite backend for cloud-based draft storage. Math is deterministic
JavaScript — no LLM is used for calculation. This is the Nadya
workspace edition of the calculator.

## Architecture

- **Frontend** — vanilla HTML/CSS/JS in `public/` (`index.html`, `styles.css`,
  `app.js`, `calc.js`). The server serves **only** this directory, never the
  project root, so `server.js`, `package.json`, and `node_modules/` are not
  publicly reachable.
- **Backend** — Node.js + Express server (`server.js`) that serves the static
  assets and exposes a small JSON API backed by SQLite (`data.db`).
- **Cloud storage** — one draft per `(access_code_hash, tax_year)`. Access codes
  are SHA-256 hashed before they touch the database; the raw code is never
  stored. Drafts contain trips, day-count settings, and eligibility fields.

The browser does **not** use `localStorage`, `sessionStorage` or IndexedDB.
Drafts only persist when the user explicitly saves them to the cloud (or has
autosave enabled and an access code entered).

## Files

- `public/index.html` — Russian UI: cloud sync, settings, trip rows, KPI cards,
  country breakdown, warnings, disclaimer, source links.
- `public/calc.js` — deterministic calculation engine.
- `public/app.js` — UI controller, sample loaders, render pipeline, cloud sync client.
- `public/styles.css` — Pink-toned Cyprus palette (rose / blush gradients), mobile-responsive.
- `server.js` — Express + better-sqlite3 server with the `/api/*` endpoints,
  rate limiting, and `public/` as the only static root.
- `tests/smoke.js` — Node smoke test exercising the API end-to-end against a
  temporary database.

## API

All requests/responses are JSON.

- `GET /api/health` → `{ ok: true, service, db }`.
- `GET /api/draft?access_code=...&tax_year=...` →
  `{ ok: true, found: false }` if nothing saved, or
  `{ ok: true, found: true, payload, updated_at }`.
- `POST /api/draft` with body `{ access_code, payload }` →
  `{ ok: true, updated_at }`.
  - `payload` must contain a valid `tax_year`; `settings`, `trips`, and the
    three eligibility fields are validated against an allowlist before being
    written.
- `DELETE /api/draft?access_code=...&tax_year=...` →
  `{ ok: true, deleted }`.

The access code must be between **8 and 128 characters**. Payload size is
capped at 256 KB and trips at 500 entries to keep writes well-formed.

`/api/*` is rate-limited to ~60 requests per minute per client IP via
`express-rate-limit`. Tune with `API_RATE_LIMIT_MAX` /
`API_RATE_LIMIT_WINDOW_MS`, or set `API_RATE_LIMIT_DISABLED=1` (the smoke
test sets this so its back-to-back calls do not flake).

## Run locally

```bash
cd cyprus-60-day-calculator
npm install
npm start
# open http://localhost:5050/
```

The SQLite database file `data.db` is created automatically in the project
root on first request. The `start` script reads `PORT`, `HOST` and `DB_PATH`
from the environment if set.

## Run the smoke test

```bash
npm test
```

The smoke test boots the server against a temporary database, exercises
`health`, `save`, `load`, validation failure and `delete`, then tears the
database file down.

## Deployment

Deploy as a Node web service so the SQLite file can persist on disk. The
project ships with `npm start` and an `engines.node >= 18` declaration, which
works directly on platforms like Railway, Render, Fly.io, Replit, or any
container host:

1. Build/Install: `npm install`.
2. Start: `npm start`.
3. Expose the port the platform injects via `process.env.PORT`.
4. Mount or otherwise persist `data.db` (or set `DB_PATH` to a path on a
   persistent volume), otherwise drafts are lost when the container is
   recycled.
5. If the host wants a `dist_path` for the static bundle, point it at
   `public/` — that is the only directory the running server exposes. The
   legacy `dist/public/` copy is kept in sync for tooling that still expects
   it.

GitHub Pages cannot host this app any more, because it requires a Node
process to serve the API.

## Cloud usage from the UI

1. Type an access code in **«Облачное хранение»** (this is your personal
   secret; pick something at least 8 characters long that only you know).
2. Press **«Сохранить в облако»** to store the current trips, settings and
   eligibility answers under `(your code, tax year)`.
3. From any other device, type the same code + tax year and press
   **«Загрузить из облака»**.
4. Status messages report: saved (with timestamp), loaded (with timestamp),
   no draft found, validation errors, or network/server errors.
5. Autosave after **«Рассчитать»** is on by default and only triggers when a
   code is present; uncheck the toggle to disable.

## Sources cited in UI

- [PwC Worldwide Tax Summaries — Cyprus, Individual Residence](https://taxsummaries.pwc.com/cyprus/individual/residence)
- [Constantinos Markou & Co — Cyprus Tax Residency](https://www.cmarkou.com/tax/cyprus-tax-residency/)

## Known limitations

- The country alias list covers ~35 common countries; unknown country strings
  pass through verbatim (no error unless empty).
- Date inputs use the native browser `<input type="date">` widget, which
  renders MM/DD/YYYY in some locales but stores ISO `YYYY-MM-DD` — the
  calculation always uses the ISO value.
- Same-day departure-and-return-to-Cyprus detection works only between
  separate trip rows; it does not model intra-row trips.
- Access codes are SHA-256 hashed; `/api/*` is per-IP rate-limited. Pick a
  long, unique code (minimum 8 characters); avoid short common values like
  `password` or `nadya123`.

## Legal disclaimer

The UI prominently states the calculator is **not legal or tax advice**. Both
source URLs are linked in the disclaimer section.
