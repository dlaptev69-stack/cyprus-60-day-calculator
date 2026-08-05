// Cloud persistence backend for the Cyprus 60-day calculator.
// Serves the static frontend and exposes a small JSON API backed by SQLite.
// Drafts are keyed by (access_code_hash, tax_year).
//
// There are two ways in:
//
//   /api/default-draft/*  — the shared default profile the UI uses. The caller
//                           sends no access code; the server substitutes one it
//                           keeps to itself, so opening the bare URL on any
//                           device shows the same trips.
//   /api/draft            — legacy per-workspace mode, kept for anyone still
//                           holding a private link. The frontend no longer
//                           calls it.

const path = require("path");
const crypto = require("crypto");
const express = require("express");
const rateLimit = require("express-rate-limit");
const Database = require("better-sqlite3");
// The same ordering rule the frontend uses, so a draft is stored sorted even if
// an older client (or a direct API call) sends trips out of order.
const { sortTripsByDate } = require("./public/calc.js");

const PORT = Number(process.env.PORT) || 5050;
const HOST = process.env.HOST || "0.0.0.0";
const DB_PATH = process.env.DB_PATH || path.join(__dirname, "data.db");
const PUBLIC_DIR = path.join(__dirname, "public");
const MAX_PAYLOAD_BYTES = 256 * 1024; // generous upper bound for trip lists
const MAX_TRIPS = 500;
const ACCESS_CODE_MIN = 8;
const ACCESS_CODE_MAX = 128;
// Per-IP API rate limit: ~60 req/min. Disabled in tests so the smoke suite
// can fire its requests back-to-back without flaking.
const API_RATE_LIMIT_MAX = Number(process.env.API_RATE_LIMIT_MAX) || 60;
const API_RATE_LIMIT_WINDOW_MS = Number(process.env.API_RATE_LIMIT_WINDOW_MS) || 60 * 1000;
const API_RATE_LIMIT_DISABLED = process.env.API_RATE_LIMIT_DISABLED === "1";

// ---- Draft version history ------------------------------------------------
// Every time a draft is replaced by a *different* payload, the payload being
// replaced is archived in `draft_versions`. That makes an accidental overwrite
// (a stale tab, a mis-click, a blank form) recoverable by the user from the UI
// instead of requiring a DB dig. Only the last VERSION_CAP payloads per
// (access_code_hash, tax_year) are kept.
const VERSION_CAP = 100;
const VERSION_LIST_DEFAULT = 20;

// Content summaries shown in both the version list and the recovery inventory.
const COMMENT_PREVIEW_CHARS = 80;
const COMMENT_PREVIEW_MAX = 5;

// ---- Persistence self-check ----------------------------------------------
// On Railway the container filesystem is recreated on every deploy, so the
// SQLite file has to live on a mounted volume (/data) or drafts vanish. These
// are surfaced through /api/health so the state is checkable without SSH.
const EXPECTED_PRODUCTION_DB_PATH = "/data/data.db";
const RESOLVED_DB_PATH = path.resolve(DB_PATH);
const IS_PRODUCTION =
  process.env.NODE_ENV === "production" ||
  Boolean(process.env.RAILWAY_ENVIRONMENT || process.env.RAILWAY_SERVICE_ID || process.env.RAILWAY_PROJECT_ID);

// ---- Default (shared) profile ---------------------------------------------
// The whole point of the app for its single user: open the URL anywhere, see
// the same trips. The frontend therefore sends no access code at all — the
// server owns one and maps every /api/default-draft/* call onto it, so the code
// never reaches browser JS and cannot leak through a screenshot or a shared
// link.
//
// The built-in fallback exists only so a misconfigured deploy still works
// instead of losing writes. It is a well-known string, published in this
// source file: on any deployment reachable from the internet, set
// DEFAULT_WORKSPACE_ACCESS_CODE to a private value (see README).
//
// The fallback is edition-specific so that two editions of this app pointed at
// one database do not silently share a single profile.
const BUILTIN_DEFAULT_WORKSPACE_ACCESS_CODE = "nadya-cyprus60-default-workspace-v1";
const DEFAULT_WORKSPACE_ACCESS_CODE =
  (process.env.DEFAULT_WORKSPACE_ACCESS_CODE || "").trim() || BUILTIN_DEFAULT_WORKSPACE_ACCESS_CODE;
const DEFAULT_WORKSPACE_ENV_SET =
  DEFAULT_WORKSPACE_ACCESS_CODE !== BUILTIN_DEFAULT_WORKSPACE_ACCESS_CODE;

// ---- Optional access password ---------------------------------------------
// Unset by default: the app is then wide open and anyone with the URL edits the
// same list. Setting APP_ACCESS_PASSWORD puts a login in front of every
// default-profile endpoint.
//
// The session cookie is a self-validating HMAC over its own issue time, keyed
// by the password. Nothing is stored server-side, so sessions survive a
// redeploy, and changing the password invalidates every outstanding cookie.
const APP_ACCESS_PASSWORD = (process.env.APP_ACCESS_PASSWORD || "").trim();
const PASSWORD_ENABLED = APP_ACCESS_PASSWORD.length > 0;
const SESSION_COOKIE = "cyprus60_session";
const SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const LOGIN_RATE_LIMIT_MAX = Number(process.env.LOGIN_RATE_LIMIT_MAX) || 10;
const LOGIN_RATE_LIMIT_WINDOW_MS = Number(process.env.LOGIN_RATE_LIMIT_WINDOW_MS) || 15 * 60 * 1000;

// ---- Temporary recovery/admin surface -------------------------------------
// Off unless RECOVERY_TOKEN is set to a sufficiently long secret. Access codes
// are only ever stored as SHA-256 hashes, so a lost workspace key cannot be
// recovered — but the payload behind it can be listed and copied onto a new
// key. Unset RECOVERY_TOKEN to remove the surface again.
const RECOVERY_TOKEN = (process.env.RECOVERY_TOKEN || "").trim();
const RECOVERY_TOKEN_MIN = 16;
const RECOVERY_ENABLED = RECOVERY_TOKEN.length >= RECOVERY_TOKEN_MIN;
const HASH_PREFIX_LEN = 12;
const HASH_PREFIX_MIN = 6;
const RECOVERY_LIMIT_DEFAULT = 100;
const RECOVERY_LIMIT_MAX = 500;

if (RECOVERY_TOKEN && !RECOVERY_ENABLED) {
  console.warn(
    `RECOVERY_TOKEN is shorter than ${RECOVERY_TOKEN_MIN} characters — recovery endpoints stay disabled.`,
  );
}

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.exec(`
  CREATE TABLE IF NOT EXISTS drafts (
    access_code_hash TEXT NOT NULL,
    tax_year         INTEGER NOT NULL,
    payload_json     TEXT NOT NULL,
    updated_at       TEXT NOT NULL,
    PRIMARY KEY (access_code_hash, tax_year)
  );

  -- Archive of superseded draft payloads. Summaries (trip count, countries,
  -- dates) are derived from payload_json on read, so there is no denormalised
  -- copy that can drift away from the payload it describes.
  CREATE TABLE IF NOT EXISTS draft_versions (
    version_id       INTEGER PRIMARY KEY AUTOINCREMENT,
    access_code_hash TEXT    NOT NULL,
    tax_year         INTEGER NOT NULL,
    payload_json     TEXT    NOT NULL,
    payload_sha256   TEXT    NOT NULL,
    saved_at         TEXT    NOT NULL,
    created_at       TEXT    NOT NULL,
    source           TEXT    NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_draft_versions_workspace
    ON draft_versions (access_code_hash, tax_year, version_id DESC);
`);

const upsertStmt = db.prepare(`
  INSERT INTO drafts (access_code_hash, tax_year, payload_json, updated_at)
  VALUES (@hash, @year, @json, @updated_at)
  ON CONFLICT(access_code_hash, tax_year) DO UPDATE SET
    payload_json = excluded.payload_json,
    updated_at   = excluded.updated_at
`);
const selectStmt = db.prepare(`
  SELECT payload_json, updated_at FROM drafts
  WHERE access_code_hash = ? AND tax_year = ?
`);
const deleteStmt = db.prepare(`
  DELETE FROM drafts WHERE access_code_hash = ? AND tax_year = ?
`);
const countStmt = db.prepare(`SELECT COUNT(*) AS n FROM drafts`);
const prefixMatchStmt = db.prepare(`
  SELECT access_code_hash, payload_json, updated_at FROM drafts
  WHERE tax_year = ? AND access_code_hash LIKE ?
`);

const insertVersionStmt = db.prepare(`
  INSERT INTO draft_versions
    (access_code_hash, tax_year, payload_json, payload_sha256, saved_at, created_at, source)
  VALUES (@hash, @year, @json, @sha, @saved_at, @created_at, @source)
`);
const latestVersionStmt = db.prepare(`
  SELECT payload_sha256 FROM draft_versions
  WHERE access_code_hash = ? AND tax_year = ?
  ORDER BY version_id DESC LIMIT 1
`);
const listVersionsStmt = db.prepare(`
  SELECT version_id, payload_json, saved_at, created_at, source FROM draft_versions
  WHERE access_code_hash = ? AND tax_year = ?
  ORDER BY version_id DESC LIMIT ?
`);
// Scoping the lookup by hash + year is what makes cross-workspace restore
// impossible: a version_id from another workspace simply does not match.
const getVersionStmt = db.prepare(`
  SELECT version_id, payload_json, saved_at, created_at, source FROM draft_versions
  WHERE version_id = ? AND access_code_hash = ? AND tax_year = ?
`);
const pruneVersionsStmt = db.prepare(`
  DELETE FROM draft_versions
  WHERE access_code_hash = @hash AND tax_year = @year AND version_id NOT IN (
    SELECT version_id FROM draft_versions
    WHERE access_code_hash = @hash AND tax_year = @year
    ORDER BY version_id DESC LIMIT @cap
  )
`);
const deleteVersionsStmt = db.prepare(`
  DELETE FROM draft_versions WHERE access_code_hash = ? AND tax_year = ?
`);
const countVersionsStmt = db.prepare(`
  SELECT COUNT(*) AS n FROM draft_versions WHERE access_code_hash = ? AND tax_year = ?
`);

function hashCode(code) {
  return crypto.createHash("sha256").update(String(code), "utf8").digest("hex");
}

function sha256Hex(text) {
  return crypto.createHash("sha256").update(text, "utf8").digest("hex");
}

// Archives the draft row that is about to be replaced. Returns the new
// version_id, or null when there is nothing worth keeping: no prior draft, or
// an identical payload already sits at the head of the history (dedupe, so a
// save/restore round-trip does not spam the list).
function archiveDraft(hash, year, current, source) {
  if (!current) return null;
  const sha = sha256Hex(current.payload_json);
  const head = latestVersionStmt.get(hash, year);
  if (head && head.payload_sha256 === sha) return null;
  const info = insertVersionStmt.run({
    hash,
    year,
    json: current.payload_json,
    sha,
    saved_at: current.updated_at,
    created_at: new Date().toISOString(),
    source,
  });
  pruneVersionsStmt.run({ hash, year, cap: VERSION_CAP });
  return info.lastInsertRowid;
}

// The only write path for drafts. Archiving the outgoing payload and writing
// the incoming one share a transaction so a crash can never lose both.
const saveDraft = db.transaction((hash, year, json, updatedAt, source) => {
  const current = selectStmt.get(hash, year);
  const changed = !current || current.payload_json !== json;
  const archivedVersionId = changed ? archiveDraft(hash, year, current, source) : null;
  upsertStmt.run({ hash, year, json, updated_at: updatedAt });
  return { changed, archived_version_id: archivedVersionId };
});

const restoreVersion = db.transaction((hash, year, versionId, updatedAt) => {
  const version = getVersionStmt.get(versionId, hash, year);
  if (!version) return { error: "not_found" };
  let payload;
  try {
    payload = JSON.parse(version.payload_json);
  } catch (e) {
    return { error: "corrupted" };
  }
  const current = selectStmt.get(hash, year);
  const archivedVersionId =
    current && current.payload_json !== version.payload_json
      ? archiveDraft(hash, year, current, "restore")
      : null;
  upsertStmt.run({ hash, year, json: version.payload_json, updated_at: updatedAt });
  return { payload, saved_at: version.saved_at, archived_version_id: archivedVersionId };
});

// Dropping a draft drops its history with it: a user asking to delete their
// data did not ask for a copy to be kept around.
const deleteDraftWithHistory = db.transaction((hash, year) => ({
  deleted: deleteStmt.run(hash, year).changes,
  deleted_versions: deleteVersionsStmt.run(hash, year).changes,
}));

function normalizeAccessCode(raw) {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (trimmed.length < ACCESS_CODE_MIN || trimmed.length > ACCESS_CODE_MAX) return null;
  return trimmed;
}

function normalizeTaxYear(raw) {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1900 || n > 2200) return null;
  return n;
}

function normalizeHashPrefix(raw) {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim().toLowerCase();
  // Hex-only, so it is safe to splice into a bound LIKE pattern (no wildcards).
  if (!/^[0-9a-f]+$/.test(trimmed)) return null;
  if (trimmed.length < HASH_PREFIX_MIN || trimmed.length > 64) return null;
  return trimmed;
}

function isTruthyFlag(raw) {
  return raw === "1" || raw === true || raw === 1 || raw === "true";
}

// ---- Optional password gate -----------------------------------------------

function readCookie(req, name) {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(eq + 1).trim());
    } catch (e) {
      return null;
    }
  }
  return null;
}

function signSession(issuedAt) {
  return crypto
    .createHmac("sha256", APP_ACCESS_PASSWORD)
    .update(`cyprus60-session|v1|${issuedAt}`, "utf8")
    .digest("hex");
}

function issueSessionToken() {
  const issuedAt = Date.now();
  return `v1.${issuedAt}.${signSession(issuedAt)}`;
}

function sessionTokenValid(token) {
  if (typeof token !== "string") return false;
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== "v1") return false;
  const issuedAt = Number(parts[1]);
  if (!Number.isInteger(issuedAt)) return false;
  const age = Date.now() - issuedAt;
  if (age < 0 || age > SESSION_MAX_AGE_MS) return false;
  const expected = Buffer.from(signSession(issuedAt), "utf8");
  const provided = Buffer.from(parts[2], "utf8");
  if (expected.length !== provided.length) return false;
  return crypto.timingSafeEqual(expected, provided);
}

function passwordMatches(provided) {
  if (typeof provided !== "string" || provided.length === 0) return false;
  // Digest both sides so timingSafeEqual always sees equal-length buffers.
  const a = crypto.createHash("sha256").update(provided, "utf8").digest();
  const b = crypto.createHash("sha256").update(APP_ACCESS_PASSWORD, "utf8").digest();
  return crypto.timingSafeEqual(a, b);
}

// Accepts the session cookie or the same token as a bearer header, so a script
// (or curl) can drive the default profile without a cookie jar.
function isAuthenticated(req) {
  if (!PASSWORD_ENABLED) return true;
  if (sessionTokenValid(readCookie(req, SESSION_COOKIE))) return true;
  const bearer = /^bearer\s+(.+)$/i.exec(req.get("authorization") || "");
  return Boolean(bearer && sessionTokenValid(bearer[1].trim()));
}

function requireAppAccess(req, res, next) {
  if (isAuthenticated(req)) return next();
  res.status(401).json({ ok: false, error: "authentication required", auth_required: true });
}

function sessionCookieOptions(req) {
  return {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    // Behind Railway's proxy the app itself speaks http, so trust the
    // forwarded scheme when deciding whether Secure is safe to set.
    secure: req.secure || req.get("x-forwarded-proto") === "https",
  };
}

function extractRecoveryToken(req) {
  const auth = req.get("authorization") || "";
  const bearer = /^bearer\s+(.+)$/i.exec(auth);
  if (bearer) return bearer[1].trim();
  if (typeof req.query.token === "string") return req.query.token;
  if (req.body && typeof req.body.token === "string") return req.body.token;
  return "";
}

function recoveryTokenMatches(provided) {
  if (typeof provided !== "string" || provided.length === 0) return false;
  // Digest both sides so timingSafeEqual always sees equal-length buffers.
  const a = crypto.createHash("sha256").update(provided, "utf8").digest();
  const b = crypto.createHash("sha256").update(RECOVERY_TOKEN, "utf8").digest();
  return crypto.timingSafeEqual(a, b);
}

function requireRecoveryToken(req, res, next) {
  // 404 rather than 403 so a disabled deployment does not advertise the route.
  if (!RECOVERY_ENABLED) {
    return res.status(404).json({ ok: false, error: "recovery endpoints are disabled" });
  }
  if (!recoveryTokenMatches(extractRecoveryToken(req))) {
    return res.status(401).json({ ok: false, error: "invalid recovery token" });
  }
  next();
}

// Human-readable description of a stored payload: enough for a user to tell two
// versions apart without any of the payload itself being echoed back.
function summarizePayload(payloadJson) {
  let payload = null;
  let corrupted = false;
  try {
    payload = JSON.parse(payloadJson);
  } catch (e) {
    corrupted = true;
  }
  const trips = payload && Array.isArray(payload.trips) ? payload.trips : [];
  const isText = (v) => typeof v === "string" && v.trim() !== "";
  const dates = trips
    .flatMap((t) => [t && t.date_arrival, t && t.date_departure])
    .filter(isText)
    .sort();
  const comments = trips
    .map((t) => t && t.comment)
    .filter(isText)
    .map((c) => c.trim().slice(0, COMMENT_PREVIEW_CHARS));
  const summary = {
    trip_count: trips.length,
    countries: [...new Set(trips.map((t) => t && t.trip_country).filter(isText))].sort(),
    earliest_date: dates[0] || null,
    latest_date: dates.length ? dates[dates.length - 1] : null,
    comment_count: comments.length,
    comments_preview: comments.slice(0, COMMENT_PREVIEW_MAX),
    payload_bytes: Buffer.byteLength(payloadJson, "utf8"),
  };
  if (corrupted) summary.corrupted = true;
  return { summary, payload };
}

// Summary of one draft row. `access_code_hash` is deliberately truncated: the
// full hash is a brute-forceable handle on a user's workspace.
function summarizeDraft(row, { includePayload }) {
  const { summary, payload } = summarizePayload(row.payload_json);
  const out = {
    access_code_hash_prefix: row.access_code_hash.slice(0, HASH_PREFIX_LEN),
    tax_year: row.tax_year,
    updated_at: row.updated_at,
    ...summary,
  };
  if (includePayload) out.payload = payload;
  return out;
}

function persistenceInfo() {
  let pathClass = "other";
  if (RESOLVED_DB_PATH === EXPECTED_PRODUCTION_DB_PATH) {
    pathClass = "railway-volume";
  } else if (RESOLVED_DB_PATH.startsWith(`/data${path.sep}`)) {
    pathClass = "persistent-volume";
  } else if (RESOLVED_DB_PATH.startsWith(__dirname + path.sep)) {
    pathClass = "app-directory";
  }
  const durable = pathClass === "railway-volume" || pathClass === "persistent-volume";
  const warnings = [];
  if (IS_PRODUCTION && !durable) {
    warnings.push(
      `DB_PATH resolves outside /data (${pathClass}) — set DB_PATH=${EXPECTED_PRODUCTION_DB_PATH} and mount a volume at /data, otherwise every redeploy wipes the drafts.`,
    );
  }
  if (!DEFAULT_WORKSPACE_ENV_SET) {
    warnings.push(
      "DEFAULT_WORKSPACE_ACCESS_CODE is not set — the shared profile is using the built-in identifier published in server.js. Set it to a private value.",
    );
  }
  if (!PASSWORD_ENABLED) {
    warnings.push(
      "APP_ACCESS_PASSWORD is not set — anyone who knows the URL can read and edit the shared trip list.",
    );
  }
  return {
    // Only the basename and a coarse class: the absolute path is not exposed.
    db_file: path.basename(DB_PATH),
    path_class: pathClass,
    db_path_env_set: Boolean(process.env.DB_PATH),
    expected_production_db_path: EXPECTED_PRODUCTION_DB_PATH,
    production: IS_PRODUCTION,
    durable,
    draft_version_cap: VERSION_CAP,
    // Whether the code is configured, never the code itself.
    default_workspace_env_set: DEFAULT_WORKSPACE_ENV_SET,
    password_required: PASSWORD_ENABLED,
    warnings,
  };
}

const DAY_TYPES = new Set(["stay", "transit", "unknown"]);
const YN = new Set(["yes", "no", "unknown"]);
const SETTING_KEYS = [
  "arrival_day_counts_for_cyprus",
  "departure_day_counts_for_cyprus",
  "same_day_arrival_departure_counts_for_cyprus",
  "same_day_departure_return_counts_for_cyprus",
  "transit_day_counts_for_cyprus",
  "arrival_day_counts_other_countries",
  "departure_day_counts_other_countries",
];

function validatePayload(p) {
  if (!p || typeof p !== "object") return "payload must be an object";
  if (normalizeTaxYear(p.tax_year) === null) return "invalid tax_year";
  for (const k of [
    "has_cyprus_home",
    "has_cyprus_business_or_employment_or_directorship",
    "possible_tax_resident_elsewhere",
  ]) {
    if (p[k] !== undefined && p[k] !== null && !YN.has(p[k])) {
      return `invalid ${k}`;
    }
  }
  if (p.settings !== undefined && p.settings !== null) {
    if (typeof p.settings !== "object") return "settings must be an object";
    for (const k of Object.keys(p.settings)) {
      if (!SETTING_KEYS.includes(k)) return `unknown settings key: ${k}`;
      if (typeof p.settings[k] !== "boolean") return `settings.${k} must be boolean`;
    }
  }
  if (p.trips !== undefined && p.trips !== null) {
    if (!Array.isArray(p.trips)) return "trips must be an array";
    if (p.trips.length > MAX_TRIPS) return `too many trips (max ${MAX_TRIPS})`;
    for (let i = 0; i < p.trips.length; i++) {
      const t = p.trips[i];
      if (!t || typeof t !== "object") return `trip[${i}] must be an object`;
      for (const k of ["trip_country", "date_arrival", "date_departure", "comment"]) {
        if (t[k] !== undefined && t[k] !== null && typeof t[k] !== "string") {
          return `trip[${i}].${k} must be a string`;
        }
        if (typeof t[k] === "string" && t[k].length > 200) {
          return `trip[${i}].${k} too long`;
        }
      }
      if (t.day_type !== undefined && t.day_type !== null && !DAY_TYPES.has(t.day_type)) {
        return `trip[${i}].day_type invalid`;
      }
    }
  }
  return null;
}

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: MAX_PAYLOAD_BYTES }));
app.use((err, req, res, next) => {
  if (err && err.type === "entity.too.large") {
    return res.status(413).json({ ok: false, error: "payload too large" });
  }
  next(err);
});

if (!API_RATE_LIMIT_DISABLED) {
  const apiLimiter = rateLimit({
    windowMs: API_RATE_LIMIT_WINDOW_MS,
    limit: API_RATE_LIMIT_MAX,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    message: { ok: false, error: "rate limit exceeded, try again shortly" },
  });
  app.use("/api/", apiLimiter);
}

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    service: "cyprus-60-day-calculator",
    db: path.basename(DB_PATH),
    persistence: persistenceInfo(),
  });
});

// The four draft operations, written once against an already-resolved
// workspace hash. The /api/draft routes resolve that hash from a caller-supplied
// access code; the /api/default-draft routes resolve it from the server-side
// default. Keeping one implementation is what stops the shared profile from
// drifting away from the legacy one.

function handleLoad(res, hash, year) {
  const row = selectStmt.get(hash, year);
  if (!row) return res.json({ ok: true, found: false });
  let payload;
  try {
    payload = JSON.parse(row.payload_json);
  } catch (e) {
    return res.status(500).json({ ok: false, error: "stored payload corrupted" });
  }
  res.json({ ok: true, found: true, payload, updated_at: row.updated_at });
}

function handleSave(res, hash, payload) {
  const err = validatePayload(payload);
  if (err) return res.status(400).json({ ok: false, error: err });
  const year = normalizeTaxYear(payload.tax_year);
  const stored = Array.isArray(payload.trips)
    ? { ...payload, trips: sortTripsByDate(payload.trips) }
    : payload;
  const updatedAt = new Date().toISOString();
  const result = saveDraft(hash, year, JSON.stringify(stored), updatedAt, "overwrite");
  res.json({
    ok: true,
    tax_year: year,
    updated_at: updatedAt,
    changed: result.changed,
    archived_version_id: result.archived_version_id,
  });
}

function handleVersions(res, hash, year, limitRaw) {
  const requestedLimit = Number.parseInt(limitRaw, 10);
  const limit = Number.isInteger(requestedLimit)
    ? Math.min(Math.max(requestedLimit, 1), VERSION_CAP)
    : VERSION_LIST_DEFAULT;

  const currentRow = selectStmt.get(hash, year);
  const rows = listVersionsStmt.all(hash, year, limit);

  res.json({
    ok: true,
    tax_year: year,
    version_cap: VERSION_CAP,
    total_versions: countVersionsStmt.get(hash, year).n,
    returned: rows.length,
    current: currentRow
      ? { current: true, updated_at: currentRow.updated_at, ...summarizePayload(currentRow.payload_json).summary }
      : null,
    versions: rows.map((row) => ({
      version_id: row.version_id,
      saved_at: row.saved_at,
      archived_at: row.created_at,
      source: row.source,
      ...summarizePayload(row.payload_json).summary,
    })),
  });
}

function handleRestore(res, hash, year, versionIdRaw) {
  const versionId = Number(versionIdRaw);
  if (!Number.isInteger(versionId) || versionId < 1) {
    return res.status(400).json({ ok: false, error: "invalid version_id" });
  }
  const updatedAt = new Date().toISOString();
  const result = restoreVersion(hash, year, versionId, updatedAt);
  if (result.error === "not_found") {
    return res.status(404).json({ ok: false, error: "no such version for this workspace and tax_year" });
  }
  if (result.error === "corrupted") {
    return res.status(500).json({ ok: false, error: "stored version corrupted, refusing to restore" });
  }
  res.json({
    ok: true,
    restored: true,
    tax_year: year,
    version_id: versionId,
    restored_from: result.saved_at,
    archived_version_id: result.archived_version_id,
    updated_at: updatedAt,
    payload: result.payload,
  });
}

// ---- Default (shared) profile routes --------------------------------------
// No access_code in, no access_code (and no hash) out.

const defaultHash = () => hashCode(DEFAULT_WORKSPACE_ACCESS_CODE);

app.get("/api/auth/status", (req, res) => {
  res.json({ ok: true, password_required: PASSWORD_ENABLED, authenticated: isAuthenticated(req) });
});

const loginLimiter = API_RATE_LIMIT_DISABLED
  ? (_req, _res, next) => next()
  : rateLimit({
      windowMs: LOGIN_RATE_LIMIT_WINDOW_MS,
      limit: LOGIN_RATE_LIMIT_MAX,
      standardHeaders: "draft-7",
      legacyHeaders: false,
      skipSuccessfulRequests: true,
      message: { ok: false, error: "too many login attempts, try again later" },
    });

app.post("/api/auth/login", loginLimiter, (req, res) => {
  if (!PASSWORD_ENABLED) {
    return res.json({ ok: true, password_required: false, authenticated: true });
  }
  if (!passwordMatches(req.body && req.body.password)) {
    return res.status(401).json({ ok: false, error: "invalid password" });
  }
  const token = issueSessionToken();
  res.cookie(SESSION_COOKIE, token, { ...sessionCookieOptions(req), maxAge: SESSION_MAX_AGE_MS });
  res.json({ ok: true, password_required: true, authenticated: true, token });
});

app.post("/api/auth/logout", (req, res) => {
  res.clearCookie(SESSION_COOKIE, sessionCookieOptions(req));
  res.json({ ok: true, authenticated: !PASSWORD_ENABLED });
});

app.get("/api/default-draft", requireAppAccess, (req, res) => {
  const year = normalizeTaxYear(req.query.tax_year);
  if (year === null) return res.status(400).json({ ok: false, error: "invalid tax_year" });
  handleLoad(res, defaultHash(), year);
});

app.post("/api/default-draft", requireAppAccess, (req, res) => {
  handleSave(res, defaultHash(), req.body && req.body.payload);
});

app.get("/api/default-draft/versions", requireAppAccess, (req, res) => {
  const year = normalizeTaxYear(req.query.tax_year);
  if (year === null) return res.status(400).json({ ok: false, error: "invalid tax_year" });
  handleVersions(res, defaultHash(), year, req.query.limit);
});

app.post("/api/default-draft/restore", requireAppAccess, (req, res) => {
  const body = req.body || {};
  const year = normalizeTaxYear(body.tax_year);
  if (year === null) return res.status(400).json({ ok: false, error: "invalid tax_year" });
  handleRestore(res, defaultHash(), year, body.version_id);
});

// ---- Legacy per-workspace routes ------------------------------------------
// Superseded by the default profile but still live, so an old private link
// keeps resolving. Not called by the shipped frontend.

app.get("/api/draft", (req, res) => {
  const code = normalizeAccessCode(req.query.access_code);
  const year = normalizeTaxYear(req.query.tax_year);
  if (!code) return res.status(400).json({ ok: false, error: `invalid access_code (must be ${ACCESS_CODE_MIN}–${ACCESS_CODE_MAX} chars)` });
  if (year === null) return res.status(400).json({ ok: false, error: "invalid tax_year" });
  handleLoad(res, hashCode(code), year);
});

app.post("/api/draft", (req, res) => {
  const code = normalizeAccessCode(req.body && req.body.access_code);
  if (!code) return res.status(400).json({ ok: false, error: `invalid access_code (must be ${ACCESS_CODE_MIN}–${ACCESS_CODE_MAX} chars)` });
  handleSave(res, hashCode(code), req.body && req.body.payload);
});

// Version history for the caller's own workspace. Proving the workspace is the
// authorisation: without the access code there is nothing to list. Summaries
// only — never the stored payloads, and never a hash.
app.get("/api/draft/versions", (req, res) => {
  const code = normalizeAccessCode(req.query.access_code);
  const year = normalizeTaxYear(req.query.tax_year);
  if (!code) return res.status(400).json({ ok: false, error: `invalid access_code (must be ${ACCESS_CODE_MIN}–${ACCESS_CODE_MAX} chars)` });
  if (year === null) return res.status(400).json({ ok: false, error: "invalid tax_year" });
  handleVersions(res, hashCode(code), year, req.query.limit);
});

// Puts an archived version back as the current draft. The draft being replaced
// is archived first, so a restore is itself undoable.
app.post("/api/draft/restore", (req, res) => {
  const body = req.body || {};
  const code = normalizeAccessCode(body.access_code);
  const year = normalizeTaxYear(body.tax_year);
  if (!code) return res.status(400).json({ ok: false, error: `invalid access_code (must be ${ACCESS_CODE_MIN}–${ACCESS_CODE_MAX} chars)` });
  if (year === null) return res.status(400).json({ ok: false, error: "invalid tax_year" });
  handleRestore(res, hashCode(code), year, body.version_id);
});

app.delete("/api/draft", (req, res) => {
  const code = normalizeAccessCode(req.query.access_code || (req.body && req.body.access_code));
  const year = normalizeTaxYear(req.query.tax_year || (req.body && req.body.tax_year));
  if (!code) return res.status(400).json({ ok: false, error: `invalid access_code (must be ${ACCESS_CODE_MIN}–${ACCESS_CODE_MAX} chars)` });
  if (year === null) return res.status(400).json({ ok: false, error: "invalid tax_year" });
  res.json({ ok: true, ...deleteDraftWithHistory(hashCode(code), year) });
});

// Read-only inventory of stored drafts, for recovering a workspace whose key
// was lost. Full payloads only with an explicit include_payload=1.
app.get("/api/recovery/drafts", requireRecoveryToken, (req, res) => {
  const clauses = [];
  const params = [];

  if (req.query.tax_year !== undefined && req.query.tax_year !== "") {
    const year = normalizeTaxYear(req.query.tax_year);
    if (year === null) return res.status(400).json({ ok: false, error: "invalid tax_year" });
    clauses.push("tax_year = ?");
    params.push(year);
  }
  if (req.query.hash_prefix !== undefined && req.query.hash_prefix !== "") {
    const prefix = normalizeHashPrefix(req.query.hash_prefix);
    if (!prefix) {
      return res.status(400).json({
        ok: false,
        error: `invalid hash_prefix (expect ${HASH_PREFIX_MIN}–64 hex chars)`,
      });
    }
    clauses.push("access_code_hash LIKE ?");
    params.push(`${prefix}%`);
  }

  const requestedLimit = Number.parseInt(req.query.limit, 10);
  const limit = Number.isInteger(requestedLimit)
    ? Math.min(Math.max(requestedLimit, 1), RECOVERY_LIMIT_MAX)
    : RECOVERY_LIMIT_DEFAULT;

  const rows = db
    .prepare(`
      SELECT access_code_hash, tax_year, payload_json, updated_at FROM drafts
      ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""}
      ORDER BY updated_at DESC
      LIMIT ?
    `)
    .all(...params, limit);

  const includePayload = isTruthyFlag(req.query.include_payload);
  res.json({
    ok: true,
    total_drafts: countStmt.get().n,
    returned: rows.length,
    hash_prefix_len: HASH_PREFIX_LEN,
    include_payload: includePayload,
    drafts: rows.map((row) => summarizeDraft(row, { includePayload })),
  });
});

// Copies a recovered draft onto some target workspace. Needed because access
// codes are hashed, so the original key cannot be recovered — only the data
// behind it can be re-pointed at a workspace that is still reachable. Shared by
// /api/recovery/copy (target = a key the browser knows) and
// /api/recovery/copy-to-default (target = the shared profile the UI reads).
function performRecoveryCopy(res, { body, targetHash, extra }) {
  const prefix = normalizeHashPrefix(body.source_hash_prefix);
  if (!prefix) {
    return res.status(400).json({
      ok: false,
      error: `invalid source_hash_prefix (expect ${HASH_PREFIX_MIN}–64 hex chars)`,
    });
  }
  const year = normalizeTaxYear(body.tax_year);
  if (year === null) return res.status(400).json({ ok: false, error: "invalid tax_year" });

  const matches = prefixMatchStmt.all(year, `${prefix}%`);
  if (matches.length === 0) {
    return res.status(404).json({ ok: false, error: "no draft matches source_hash_prefix for that tax_year" });
  }
  if (matches.length > 1) {
    return res.status(409).json({
      ok: false,
      error: "ambiguous source_hash_prefix — supply more characters",
      matches: matches.length,
    });
  }

  const source = matches[0];
  if (targetHash === source.access_code_hash) {
    return res.status(400).json({ ok: false, error: "target already resolves to the source draft" });
  }
  let payload;
  try {
    payload = JSON.parse(source.payload_json);
  } catch (e) {
    return res.status(500).json({ ok: false, error: "source payload corrupted, refusing to copy" });
  }

  const existing = selectStmt.get(targetHash, year);
  if (existing && !isTruthyFlag(body.overwrite)) {
    return res.status(409).json({
      ok: false,
      error: "target draft already exists — resend with overwrite=1 to replace it",
      target_updated_at: existing.updated_at,
    });
  }

  // saveDraft archives whatever the target held, so an overwriting migration is
  // itself undoable from the archive UI.
  const updatedAt = new Date().toISOString();
  const saved = saveDraft(targetHash, year, source.payload_json, updatedAt, "recovery_copy");
  res.json({
    ok: true,
    copied: true,
    overwritten: Boolean(existing),
    archived_version_id: saved.archived_version_id,
    source_hash_prefix: source.access_code_hash.slice(0, HASH_PREFIX_LEN),
    source_updated_at: source.updated_at,
    target_hash_prefix: targetHash.slice(0, HASH_PREFIX_LEN),
    tax_year: year,
    trip_count: Array.isArray(payload.trips) ? payload.trips.length : 0,
    updated_at: updatedAt,
    ...extra,
  });
}

app.post("/api/recovery/copy", requireRecoveryToken, (req, res) => {
  const body = req.body || {};
  const targetCode = normalizeAccessCode(body.target_access_code);
  if (!targetCode) {
    return res.status(400).json({
      ok: false,
      error: `invalid target_access_code (must be ${ACCESS_CODE_MIN}–${ACCESS_CODE_MAX} chars)`,
    });
  }
  performRecoveryCopy(res, { body, targetHash: hashCode(targetCode) });
});

// Migration path for the shared profile: promotes a recovered draft to the one
// the UI shows, without the caller ever learning the default access code.
app.post("/api/recovery/copy-to-default", requireRecoveryToken, (req, res) => {
  performRecoveryCopy(res, {
    body: req.body || {},
    targetHash: defaultHash(),
    extra: { target: "default_profile" },
  });
});

app.use(express.static(PUBLIC_DIR, {
  extensions: ["html"],
  index: "index.html",
  dotfiles: "ignore",
}));

if (require.main === module) {
  app.listen(PORT, HOST, () => {
    console.log(`Cyprus 60-day calculator listening on http://${HOST}:${PORT}`);
    console.log(`Static root: ${PUBLIC_DIR}`);
    console.log(`SQLite database: ${DB_PATH}`);
    console.log(`Default profile: ${DEFAULT_WORKSPACE_ENV_SET ? "configured via DEFAULT_WORKSPACE_ACCESS_CODE" : "BUILT-IN FALLBACK"}`);
    console.log(`Access password: ${PASSWORD_ENABLED ? "required" : "not set (open access)"}`);
    for (const warning of persistenceInfo().warnings) console.warn(`WARNING: ${warning}`);
    if (RECOVERY_ENABLED) {
      console.log("Recovery endpoints ENABLED (/api/recovery/*) — unset RECOVERY_TOKEN to disable.");
    }
  });
}

module.exports = { app, db, hashCode };
