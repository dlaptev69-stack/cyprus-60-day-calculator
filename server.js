// Cloud persistence backend for the Cyprus 60-day calculator.
// Serves the static frontend and exposes a small JSON API backed by SQLite.
// Drafts are keyed by (access_code_hash, tax_year) so the same access code +
// tax year can be loaded from any device.

const path = require("path");
const crypto = require("crypto");
const express = require("express");
const rateLimit = require("express-rate-limit");
const Database = require("better-sqlite3");

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
const COMMENT_PREVIEW_CHARS = 80;
const COMMENT_PREVIEW_MAX = 5;
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

function hashCode(code) {
  return crypto.createHash("sha256").update(String(code), "utf8").digest("hex");
}

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

// Summary of one draft row. `access_code_hash` is deliberately truncated: the
// full hash is a brute-forceable handle on a user's workspace.
function summarizeDraft(row, { includePayload }) {
  let payload = null;
  let corrupted = false;
  try {
    payload = JSON.parse(row.payload_json);
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
    access_code_hash_prefix: row.access_code_hash.slice(0, HASH_PREFIX_LEN),
    tax_year: row.tax_year,
    updated_at: row.updated_at,
    trip_count: trips.length,
    countries: [...new Set(trips.map((t) => t && t.trip_country).filter(isText))].sort(),
    earliest_date: dates[0] || null,
    latest_date: dates.length ? dates[dates.length - 1] : null,
    comment_count: comments.length,
    comments_preview: comments.slice(0, COMMENT_PREVIEW_MAX),
    payload_bytes: Buffer.byteLength(row.payload_json, "utf8"),
  };
  if (corrupted) summary.corrupted = true;
  if (includePayload) summary.payload = payload;
  return summary;
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
  res.json({ ok: true, service: "cyprus-60-day-calculator", db: path.basename(DB_PATH) });
});

app.get("/api/draft", (req, res) => {
  const code = normalizeAccessCode(req.query.access_code);
  const year = normalizeTaxYear(req.query.tax_year);
  if (!code) return res.status(400).json({ ok: false, error: `invalid access_code (must be ${ACCESS_CODE_MIN}–${ACCESS_CODE_MAX} chars)` });
  if (year === null) return res.status(400).json({ ok: false, error: "invalid tax_year" });
  const row = selectStmt.get(hashCode(code), year);
  if (!row) return res.json({ ok: true, found: false });
  let payload;
  try {
    payload = JSON.parse(row.payload_json);
  } catch (e) {
    return res.status(500).json({ ok: false, error: "stored payload corrupted" });
  }
  res.json({ ok: true, found: true, payload, updated_at: row.updated_at });
});

app.post("/api/draft", (req, res) => {
  const code = normalizeAccessCode(req.body && req.body.access_code);
  if (!code) return res.status(400).json({ ok: false, error: `invalid access_code (must be ${ACCESS_CODE_MIN}–${ACCESS_CODE_MAX} chars)` });
  const payload = req.body && req.body.payload;
  const err = validatePayload(payload);
  if (err) return res.status(400).json({ ok: false, error: err });
  const year = normalizeTaxYear(payload.tax_year);
  const updatedAt = new Date().toISOString();
  upsertStmt.run({
    hash: hashCode(code),
    year,
    json: JSON.stringify(payload),
    updated_at: updatedAt,
  });
  res.json({ ok: true, updated_at: updatedAt });
});

app.delete("/api/draft", (req, res) => {
  const code = normalizeAccessCode(req.query.access_code || (req.body && req.body.access_code));
  const year = normalizeTaxYear(req.query.tax_year || (req.body && req.body.tax_year));
  if (!code) return res.status(400).json({ ok: false, error: `invalid access_code (must be ${ACCESS_CODE_MIN}–${ACCESS_CODE_MAX} chars)` });
  if (year === null) return res.status(400).json({ ok: false, error: "invalid tax_year" });
  const info = deleteStmt.run(hashCode(code), year);
  res.json({ ok: true, deleted: info.changes });
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

// Copies a stored payload onto a workspace key the user still has. Needed
// because access codes are hashed, so the original key cannot be recovered —
// only the data behind it can be re-pointed at a key the browser knows.
app.post("/api/recovery/copy", requireRecoveryToken, (req, res) => {
  const body = req.body || {};
  const prefix = normalizeHashPrefix(body.source_hash_prefix);
  if (!prefix) {
    return res.status(400).json({
      ok: false,
      error: `invalid source_hash_prefix (expect ${HASH_PREFIX_MIN}–64 hex chars)`,
    });
  }
  const targetCode = normalizeAccessCode(body.target_access_code);
  if (!targetCode) {
    return res.status(400).json({
      ok: false,
      error: `invalid target_access_code (must be ${ACCESS_CODE_MIN}–${ACCESS_CODE_MAX} chars)`,
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
  const targetHash = hashCode(targetCode);
  if (targetHash === source.access_code_hash) {
    return res.status(400).json({ ok: false, error: "target_access_code already resolves to the source draft" });
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

  const updatedAt = new Date().toISOString();
  upsertStmt.run({ hash: targetHash, year, json: source.payload_json, updated_at: updatedAt });
  res.json({
    ok: true,
    copied: true,
    overwritten: Boolean(existing),
    source_hash_prefix: source.access_code_hash.slice(0, HASH_PREFIX_LEN),
    source_updated_at: source.updated_at,
    target_hash_prefix: targetHash.slice(0, HASH_PREFIX_LEN),
    tax_year: year,
    trip_count: Array.isArray(payload.trips) ? payload.trips.length : 0,
    updated_at: updatedAt,
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
    if (RECOVERY_ENABLED) {
      console.log("Recovery endpoints ENABLED (/api/recovery/*) — unset RECOVERY_TOKEN to disable.");
    }
  });
}

module.exports = { app, db, hashCode };
