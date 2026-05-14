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
  });
}

module.exports = { app, db, hashCode };
