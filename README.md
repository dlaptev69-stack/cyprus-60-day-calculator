# Cyprus 60-day Calculator

Russian-language Cyprus tax residency "60-day rule" calculator with a small
Node + SQLite backend for cloud-based draft storage. Math is deterministic
JavaScript — no LLM is used for calculation.

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
- **Shared default profile** — the UI never sends an access code. It calls
  `/api/default-draft*`, and the server substitutes the code it keeps to itself
  (`DEFAULT_WORKSPACE_ACCESS_CODE`). Opening the bare URL on any device — new
  phone, new browser, cleared cookies — shows the same trip list. See
  [The shared default profile](#the-shared-default-profile).
- **Version history** — every draft overwrite archives the payload it replaced
  in `draft_versions`, so an accidental clobber is reversible from the UI. See
  [Version history](#version-history-draft_versions).

The browser does **not** use `localStorage`, `sessionStorage` or IndexedDB, and
it holds no workspace key or cookie of its own — no trip data or identifier is
kept client-side. Everything lives in server SQLite. The only cookie the app
ever sets is the httpOnly login session, and only when `APP_ACCESS_PASSWORD` is
configured. `tests/persistence.js` asserts the frontend sources contain no
web-storage API calls, no `document.cookie`, and no access code.

## The shared default profile

The requirement is "open the URL, see my trips" — from any device, with nothing
to copy or paste. So identity is a server-side constant, not something the
browser carries:

- The frontend calls `GET`/`POST /api/default-draft` with **no access code at
  all**. The server maps every such call onto
  `sha256(DEFAULT_WORKSPACE_ACCESS_CODE)`.
- That code is never sent to the browser. It is not in `app.js`, not in
  `index.html`, and not in any API response — `tests/persistence.js` and
  `tests/default-profile.js` both assert this.
- `DEFAULT_WORKSPACE_ACCESS_CODE` should be set to a private value in the
  hosting environment. If it is unset the server falls back to the **built-in,
  published** identifier `cyprus60-default-workspace-v1` so a fresh checkout
  works out of the box; `/api/health` warns while that fallback is in use.
- Because the profile is shared by definition, anyone who can reach the URL can
  read and edit the list. `APP_ACCESS_PASSWORD` is what closes that; see
  [Optional password gate](#optional-password-gate).

Legacy per-workspace mode (`/api/draft*` with an explicit `access_code`) is
still fully supported for anyone holding an old private link, and both route
families share one implementation so they cannot drift apart. The UI no longer
offers it.

## Optional password gate

Set `APP_ACCESS_PASSWORD` to require a password before the shared list can be
read or written. When it is set:

- `GET`/`POST /api/default-draft`, `/api/default-draft/versions` and
  `/api/default-draft/restore` answer `401` with `{ auth_required: true }`
  until the caller logs in.
- `POST /api/auth/login` with `{ password }` sets an **httpOnly, SameSite=Lax**
  session cookie (`Secure` behind an HTTPS proxy) and also returns the token for
  `Authorization: Bearer` use. The password itself is never stored in the
  frontend or in the cookie.
- The session token is a stateless HMAC keyed by the password, so sessions
  survive redeploys and **changing the password invalidates every existing
  session**. Sessions expire after 30 days.
- Login attempts are rate-limited separately from the rest of the API
  (`LOGIN_RATE_LIMIT_MAX`, default 10 per 15 minutes, successful logins not
  counted).

When it is **not** set the app works with no login, and both `/api/health`
`warnings` and the UI say plainly that anyone who knows the URL can view and
edit the trip list.

## Files

- `public/index.html` — Russian UI: autosave status, trip archive, login screen,
  settings, trip rows, KPI cards, country breakdown, warnings, disclaimer,
  source links.
- `public/calc.js` — deterministic calculation engine.
- `public/app.js` — UI controller, sample loaders, render pipeline, default-profile
  sync client.
- `public/styles.css` — Mediterranean limestone-and-teal palette, mobile-responsive.
- `server.js` — Express + better-sqlite3 server with the `/api/*` endpoints,
  rate limiting, and `public/` as the only static root.
- `tests/smoke.js` — Node smoke test exercising the API end-to-end against a
  temporary database.
- `tests/persistence.js` — jsdom tests booting the real frontend: fresh browsers
  with no cookie seeing the same shared list, the autosave-vs-initial-load
  ordering, and the archive restore flow.
- `tests/default-profile.js` — the default-profile API: no-access-code
  load/save, second-client equivalence, the built-in fallback, versions and
  restore, the password gate, and `POST /api/recovery/copy-to-default`.
- `tests/versions.js` — draft version history: archiving on overwrite, dedupe,
  the retention cap, restore, workspace isolation, and `/api/health` reporting.
- `tests/recovery.js` — covers the temporary `/api/recovery/*` admin surface:
  disabled by default, token enforcement, summary shape, and payload copy.

## API

All requests/responses are JSON.

- `GET /api/health` → `{ ok: true, service, db, persistence }`. See
  [Persistence self-check](#persistence-self-check).

### Shared default profile (what the UI uses)

No access code is accepted or required on these routes; the server supplies its
own. All four answer `401` when `APP_ACCESS_PASSWORD` is set and the caller has
no session.

- `GET /api/default-draft?tax_year=...` → `{ ok: true, found, payload, updated_at }`.
- `POST /api/default-draft` with body `{ payload }` →
  `{ ok: true, tax_year, updated_at, changed, archived_version_id }`.
- `GET /api/default-draft/versions?tax_year=...&limit=` →
  `{ ok: true, tax_year, version_cap, total_versions, returned, current, versions }`.
- `POST /api/default-draft/restore` with body `{ tax_year, version_id }` →
  `{ ok: true, restored: true, version_id, restored_from, archived_version_id, updated_at, payload }`.

### Authentication

- `GET /api/auth/status` → `{ ok: true, password_required, authenticated }`.
- `POST /api/auth/login` with body `{ password }` → `{ ok: true, password_required,
  authenticated, token }` and an httpOnly session cookie. Wrong password → `401`.
- `POST /api/auth/logout` → clears the cookie.

### Legacy per-workspace mode

Preserved for old private links; the UI does not call these.

- `GET /api/draft?access_code=...&tax_year=...` →
  `{ ok: true, found: false }` if nothing saved, or
  `{ ok: true, found: true, payload, updated_at }`.
- `POST /api/draft` with body `{ access_code, payload }` →
  `{ ok: true, updated_at, changed, archived_version_id }`.
  - `payload` must contain a valid `tax_year`; `settings`, `trips`, and the
    three eligibility fields are validated against an allowlist before being
    written.
  - `changed` is `false` when the incoming payload is byte-identical to the
    stored one; `archived_version_id` is the version created for the payload
    that was replaced, or `null` when nothing was replaced.
- `GET /api/draft/versions?access_code=...&tax_year=...&limit=` →
  `{ ok: true, tax_year, version_cap, total_versions, returned, current, versions }`.
- `POST /api/draft/restore` with body `{ access_code, tax_year, version_id }` →
  `{ ok: true, restored: true, version_id, restored_from, archived_version_id, updated_at, payload }`.
- `DELETE /api/draft?access_code=...&tax_year=...` →
  `{ ok: true, deleted, deleted_versions }`.

The access code must be between **8 and 128 characters**. Payload size is
capped at 256 KB and trips at 500 entries to keep writes well-formed.

`/api/*` is rate-limited to ~60 requests per minute per client IP via
`express-rate-limit`. Tune with `API_RATE_LIMIT_MAX` /
`API_RATE_LIMIT_WINDOW_MS`, or set `API_RATE_LIMIT_DISABLED=1` (the smoke
test sets this so its back-to-back calls do not flake).

## Version history (`draft_versions`)

Autosave means the current draft can be replaced at any moment — by a stale tab,
a mis-click, or a bug. So the payload being replaced is never simply discarded.

**Semantics.** `drafts` holds exactly one *current* payload per
`(access_code_hash, tax_year)`. `draft_versions` holds *superseded* payloads for
the same key. Together they are the full timeline: the current draft is always
what `GET /api/draft` serves, and everything it used to be is in the history.

A version row is written on every write path that replaces an existing draft —
`POST /api/draft` and `POST /api/default-draft` (`source: "overwrite"`), the two
restore routes (`source: "restore"`), and `POST /api/recovery/copy` /
`copy-to-default` (`source: "recovery_copy"`). Consequences worth knowing:

- **A restore is undoable.** Restoring version *N* archives the draft it
  replaced first, so the pre-restore state appears in the history immediately.
- **Nothing is archived when nothing is lost.** The first-ever save has no
  predecessor, and a payload byte-identical to the stored one is not a change.
- **Identical payloads are deduplicated.** A version is skipped if the payload
  being archived matches the newest existing version, so a save → restore →
  autosave round-trip does not fill the list with copies.
- **Retention is the newest 100 versions** per `(access_code_hash, tax_year)`;
  older rows are pruned on insert. `GET /api/draft/versions` returns 20 by
  default (`limit` up to 100) but always reports the true `total_versions`.
- **Deleting a draft deletes its history.** `DELETE /api/draft` reports
  `deleted_versions`; a user asking to delete their data does not keep a copy.

`GET /api/draft/versions` and `POST /api/draft/restore` need **no admin token**:
the access code *is* the authorisation, exactly as for `GET`/`POST /api/draft`.
Restores are looked up by `(version_id, access_code_hash, tax_year)`, so a
`version_id` belonging to another workspace or another tax year is a `404` — a
cross-workspace restore is not expressible. The list returns content summaries
only (`version_id`, `saved_at`, `archived_at`, `source`, `trip_count`,
`countries`, `earliest_date`, `latest_date`, `comment_count`,
`comments_preview`, `payload_bytes`) — never a stored payload and never a hash.

In the UI this is **«Архив поездок»**, a button directly on the autosave status
bar — no advanced panel, no token, no access code. Each entry shows the
date/time, trip count, countries and date range, and a comment preview; the live
list is shown first as «Текущая версия». Restore asks for confirmation, then
hydrates the recovered list, recalculates, and resyncs the autosave baseline so
the freshly restored data is not immediately overwritten.

«Очистить список поездок» on the same bar saves an empty list rather than
deleting anything, so clearing is archived and reversible like any other
overwrite.

## Persistence self-check

`GET /api/health` reports how durable the database actually is, so a
misconfigured volume is visible without shell access:

```json
{
  "ok": true,
  "service": "cyprus-60-day-calculator",
  "db": "data.db",
  "persistence": {
    "db_file": "data.db",
    "path_class": "railway-volume",
    "db_path_env_set": true,
    "expected_production_db_path": "/data/data.db",
    "production": true,
    "durable": true,
    "draft_version_cap": 100,
    "warnings": []
  }
}
```

Only the **basename** and a coarse `path_class` are exposed — never the absolute
path. `path_class` is `railway-volume` (exactly `/data/data.db`),
`persistent-volume` (anything else under `/data`), `app-directory` (next to
`server.js`, i.e. wiped on redeploy), or `other`. `durable` is true only for the
two volume classes. `production` is true when `NODE_ENV=production` or any
`RAILWAY_*` variable is present; in production with a non-durable path,
`warnings` explains what to fix and the same text is logged at boot.

## Recovery endpoints (temporary, off by default)

A small read-only admin surface for the case where a workspace key is lost and
drafts need to be found again. **It does not exist unless `RECOVERY_TOKEN` is
set** to a secret of at least 16 characters; without it every
`/api/recovery/*` route answers `404`. Unset the variable to remove the
surface again.

The token may be sent as `Authorization: Bearer <token>`, as a `?token=` query
parameter, or as a `token` field in the JSON body. A wrong or missing token is
`401`. `/api/recovery/*` is covered by the same per-IP rate limit as the rest
of `/api/`.

- `GET /api/recovery/drafts` → `{ ok, total_drafts, returned, hash_prefix_len,
  include_payload, drafts: [...] }`. Each entry reports `tax_year`,
  `updated_at`, `trip_count`, `countries`, `earliest_date`, `latest_date`,
  `comment_count`, `comments_preview` (up to 5 comments, 80 chars each),
  `payload_bytes`, and `access_code_hash_prefix` — the **first 12 characters
  only**. The full `access_code_hash` is never returned, and the plaintext
  access code is not in the database at all, so it cannot be recovered.
  - Optional: `tax_year=`, `hash_prefix=` (6–64 hex chars), `limit=`
    (default 100, max 500), `include_payload=1` to also return the stored
    payload.
- `POST /api/recovery/copy` with body
  `{ source_hash_prefix, target_access_code, tax_year, overwrite? }` →
  copies the payload from the matching draft onto `sha256(target_access_code)`
  for the same tax year, leaving the source row untouched. This is how a
  visible draft gets restored into the workspace key the user's browser
  currently holds. An ambiguous prefix is `409`, an unknown one `404`, and an
  existing target row is `409` unless `overwrite=1` is sent.
- `POST /api/recovery/copy-to-default` with body
  `{ source_hash_prefix, tax_year, overwrite? }` → same copy, but the target is
  the **shared default profile**, so the caller never needs to know
  `DEFAULT_WORKSPACE_ACCESS_CODE`. The response reports
  `target: "default_profile"`. This is the migration path: it promotes a
  recovered draft to the list the UI shows on every device. Same status codes as
  `/api/recovery/copy`; when `overwrite=1` replaces a populated default the
  replaced list is archived and restorable from «Архив поездок».

### Enabling it on Railway

In the Railway service → **Variables**, add:

```
RECOVERY_TOKEN=<a long random secret, 16+ chars>
```

Generate one locally with `openssl rand -hex 32`. Railway redeploys the
service on variable changes. Never commit the token; it lives only in Railway's
variable store.

**Delete `RECOVERY_TOKEN` as soon as the recovery is done.** The endpoints
disappear on the next deploy, and `/api/recovery/*` goes back to answering
`404`. Leaving it set keeps a token-guarded read surface over every workspace in
the database online indefinitely — day-to-day restores do not need it, because
the user-facing version history covers them.

### Example requests

```bash
BASE=https://<your-app>.up.railway.app
TOKEN=<the RECOVERY_TOKEN value>

# What is in the database at all?
curl -s -H "Authorization: Bearer $TOKEN" "$BASE/api/recovery/drafts" | jq

# Narrow to one tax year
curl -s -H "Authorization: Bearer $TOKEN" "$BASE/api/recovery/drafts?tax_year=2026" | jq

# Inspect one candidate in full before restoring it
curl -s -H "Authorization: Bearer $TOKEN" \
  "$BASE/api/recovery/drafts?hash_prefix=1a2b3c4d5e6f&include_payload=1" | jq

# Promote that draft to the shared default profile everyone's URL shows
curl -s -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"source_hash_prefix":"1a2b3c4d5e6f","tax_year":2026}' \
  "$BASE/api/recovery/copy-to-default" | jq

# Restore into an explicit legacy workspace key instead
curl -s -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"source_hash_prefix":"1a2b3c4d5e6f","target_access_code":"<workspace key>","tax_year":2026}' \
  "$BASE/api/recovery/copy" | jq
```

After a successful copy, reload the page — the normal load picks the restored
payload up.

### Migrating the already-recovered trips into the default profile

Denis's real trips were recovered earlier under the access code
`denis-restored-Q9owkAzM6J2VSILxlJNQjjjckQdAZvd0`, tax year 2026. They live in
their own workspace row and are **not** what the new shared URL shows until they
are copied across. Run this once after deploying:

```bash
BASE=https://cyprus-60-day-calculator-production.up.railway.app
TOKEN=<the RECOVERY_TOKEN value>

# 1. Find the hash prefix of the recovered draft and confirm the trips look right.
curl -s -H "Authorization: Bearer $TOKEN" \
  "$BASE/api/recovery/drafts?tax_year=2026" | jq '.drafts[] |
  {access_code_hash_prefix, trip_count, countries, earliest_date, latest_date}'

# 2. Copy it onto the shared default profile. Add "overwrite":"1" if the default
#    profile already holds a list you are willing to replace — the replaced list
#    is archived and restorable from «Архив поездок».
curl -s -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"source_hash_prefix":"<prefix from step 1>","tax_year":2026}' \
  "$BASE/api/recovery/copy-to-default" | jq

# 3. Verify the shared profile now serves them — no access code, like the browser.
curl -s "$BASE/api/default-draft?tax_year=2026" | jq '.found, (.payload.trips|length)'

# 4. Remove RECOVERY_TOKEN from Railway variables.
```

Step 3 needs an `Authorization: Bearer` header or the session cookie if
`APP_ACCESS_PASSWORD` is set. Then open the site on a phone and a laptop: both
must show the same trips.

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

`npm test` runs five suites in sequence: the API smoke test, the jsdom
persistence and archive-UI tests, the default-profile API tests, the
version-history tests, and the recovery-endpoint tests. Each boots the server
against a temporary database and tears the file down afterwards.

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
   `dist/public/` copy is a leftover of the old GitHub Pages build and is not
   read by the server.

GitHub Pages cannot host this app any more, because it requires a Node
process to serve the API.

### Railway: the volume is not optional

Railway rebuilds the container filesystem on every deploy. A SQLite file inside
the app directory is therefore **deleted on the next deploy, along with every
draft and its version history**. Two settings prevent that:

1. Service → **Settings → Volumes** → add a volume with mount path `/data`.
2. Service → **Variables** → set:

   ```
   DB_PATH=/data/data.db
   ```

Then confirm it took effect — this is the single check that matters after any
infrastructure change:

```bash
curl -s https://<your-app>.up.railway.app/api/health | jq .persistence
```

Expect `"path_class": "railway-volume"`, `"durable": true`, and an empty
`warnings` array. If `durable` is `false` while `production` is `true`, the
volume or the variable is missing and the next deploy will wipe the data —
`warnings` names the fix. The same warning is printed in the deploy logs at
startup.

Keep the volume mount path and `DB_PATH` in agreement. Pointing `DB_PATH`
somewhere else under `/data` still counts as durable
(`"path_class": "persistent-volume"`), but `/data/data.db` is the documented
default and the value `/api/health` reports as expected.

### Environment variables

| Variable | Required | Purpose |
| --- | --- | --- |
| `DB_PATH` | production | SQLite file location. Set to `/data/data.db` on Railway, or the data is wiped on redeploy. |
| `DEFAULT_WORKSPACE_ACCESS_CODE` | strongly recommended | Server-side identity of the shared trip list. Any long random string, 8–128 chars. Falls back to the published `cyprus60-default-workspace-v1` when unset, which `/api/health` warns about. Changing it points the URL at a *different* (empty) list — the old one stays in the database under its old hash. |
| `APP_ACCESS_PASSWORD` | recommended | Requires a password before the shared list can be read or edited. Unset means anyone with the URL can view and edit. Changing it logs everyone out. |
| `RECOVERY_TOKEN` | temporarily | Enables `/api/recovery/*`. Delete it once the migration is done. |
| `PORT`, `HOST` | no | Injected by the platform. |
| `API_RATE_LIMIT_MAX`, `API_RATE_LIMIT_WINDOW_MS`, `API_RATE_LIMIT_DISABLED` | no | Tune the per-IP `/api/` limit. |
| `LOGIN_RATE_LIMIT_MAX`, `LOGIN_RATE_LIMIT_WINDOW_MS` | no | Tune the stricter login limit (default 10 per 15 min). |

Generate the two secrets with `openssl rand -hex 32`. After setting them,
`curl -s "$BASE/api/health" | jq .persistence.warnings` should be empty.

## Usage from the UI

There is nothing to type, no link to copy and no device to pair: opening the URL
loads the one shared trip list, and every edit is autosaved back to the server
about a second later. The status line reports saving, saved-with-timestamp,
loaded-with-timestamp, or the error that stopped it.

- **Автосохранение включено** — the status bar states the list is stored on the
  calculator's server, so the same trips appear on any device.
- **Архив поездок** — lists recent versions with date/time, trip count,
  countries, date range and a comment preview; restore asks for confirmation and
  is itself undoable. No token or access code needed.
- **Очистить список поездок** — saves an empty list. The previous one stays in
  the archive.
- **Login screen** — shown only when `APP_ACCESS_PASSWORD` is set. Otherwise the
  page displays a warning that anyone with the link can view and edit the data.

Autosave stays disarmed until the initial load resolves, so a blank startup form
can never be written over the stored list. If that load fails, the status line
says autosave is paused and asks for a reload.

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
  `password` or `denis123`.
- The default profile is shared by design: there are no per-user accounts, so
  everyone who gets past `APP_ACCESS_PASSWORD` sees and edits the same list.

## Legal disclaimer

The UI prominently states the calculator is **not legal or tax advice**. Both
source URLs are linked in the disclaimer section.
