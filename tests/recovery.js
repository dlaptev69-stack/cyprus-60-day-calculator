// Tests for the temporary /api/recovery/* surface.
//
// The recovery routes read RECOVERY_TOKEN once at module load, so this suite
// boots the server twice — with the token absent, then present — by clearing
// server.js out of the require cache between phases. Each phase gets its own
// SQLite file so the two better-sqlite3 handles never share a database.
//
// Run with: npm test

const fs = require("fs");
const os = require("os");
const path = require("path");

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cyprus-60-recovery-"));
process.env.API_RATE_LIMIT_DISABLED = "1";

const SERVER = require.resolve("../server.js");
const TOKEN = "recovery-test-token-0123456789";
const YEAR = 2026;

let failures = 0;
function check(name, cond, detail) {
  if (cond) {
    console.log(`  ok  ${name}`);
  } else {
    failures++;
    console.log(`  FAIL ${name}${detail ? " — " + detail : ""}`);
  }
}

function loadServer(dbName, token) {
  delete require.cache[SERVER];
  process.env.DB_PATH = path.join(tmpDir, dbName);
  if (token) {
    process.env.RECOVERY_TOKEN = token;
  } else {
    delete process.env.RECOVERY_TOKEN;
  }
  return require(SERVER);
}

function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, "127.0.0.1", () => {
      resolve({ server, base: `http://127.0.0.1:${server.address().port}` });
    });
  });
}

const close = (server) => new Promise((resolve) => server.close(resolve));

async function seed(base, code, trips, year = YEAR) {
  const res = await fetch(`${base}/api/draft`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ access_code: code, payload: { tax_year: year, trips } }),
  });
  if (!res.ok) throw new Error(`seed failed: ${res.status}`);
}

function copy(base, body, headers = {}) {
  return fetch(`${base}/api/recovery/copy`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

const DENIS_TRIPS = [
  { trip_country: "Cyprus", date_arrival: "2026-01-10", date_departure: "2026-03-20", day_type: "stay", comment: "зимовка в Лимассоле" },
  { trip_country: "Russia", date_arrival: "2026-04-01", date_departure: "2026-04-15", day_type: "stay", comment: "работа" },
  { trip_country: "Greece", date_arrival: "2026-05-02", date_departure: "2026-05-09", day_type: "stay", comment: "" },
];
const OTHER_TRIPS = [
  { trip_country: "Georgia", date_arrival: "2026-08-01", date_departure: "2026-08-20", day_type: "stay", comment: "" },
];

async function phaseDisabled() {
  console.log("\nRECOVERY_TOKEN unset (feature off by default):");
  const { app } = loadServer("disabled.db", null);
  const { server, base } = await listen(app);
  try {
    const list = await fetch(`${base}/api/recovery/drafts`);
    check("list is 404 when RECOVERY_TOKEN is unset", list.status === 404, `status ${list.status}`);

    const guessed = await fetch(`${base}/api/recovery/drafts?token=${TOKEN}`);
    check(
      "list stays 404 even when a caller supplies a token",
      guessed.status === 404,
      `status ${guessed.status}`,
    );

    const copied = await copy(base, {
      token: TOKEN,
      source_hash_prefix: "abcdef123456",
      target_access_code: "target-code-2026",
      tax_year: YEAR,
    });
    check("copy is 404 when RECOVERY_TOKEN is unset", copied.status === 404, `status ${copied.status}`);

    const health = await fetch(`${base}/api/health`).then((r) => r.json());
    check("normal API is unaffected while recovery is off", health.ok === true);
  } finally {
    await close(server);
  }
}

async function phaseShortToken() {
  console.log("\nRECOVERY_TOKEN too short (refuses to enable):");
  const { app } = loadServer("short.db", "tiny-secret");
  const { server, base } = await listen(app);
  try {
    const list = await fetch(`${base}/api/recovery/drafts?token=tiny-secret`);
    check(
      "a token under 16 chars does not enable the endpoints",
      list.status === 404,
      `status ${list.status}`,
    );
  } finally {
    await close(server);
  }
}

async function phaseEnabled() {
  console.log("\nRECOVERY_TOKEN set (feature on):");
  const { app, hashCode } = loadServer("enabled.db", TOKEN);
  const { server, base } = await listen(app);
  const DENIS_CODE = "denis-lost-workspace-key-2026";
  const OTHER_CODE = "someone-else-key-2026";
  const RECOVER_CODE = "denis-new-browser-key-2026";
  const denisHash = hashCode(DENIS_CODE);

  try {
    await seed(base, DENIS_CODE, DENIS_TRIPS);
    await seed(base, OTHER_CODE, OTHER_TRIPS);
    await seed(base, DENIS_CODE, [DENIS_TRIPS[0]], 2025);

    // ---- token enforcement ----
    const noToken = await fetch(`${base}/api/recovery/drafts`);
    check("list without a token is 401", noToken.status === 401, `status ${noToken.status}`);

    const wrongToken = await fetch(`${base}/api/recovery/drafts?token=not-the-right-token-at-all`);
    check("list with a wrong token is 401", wrongToken.status === 401, `status ${wrongToken.status}`);

    const emptyToken = await fetch(`${base}/api/recovery/drafts?token=`);
    check("list with an empty token is 401", emptyToken.status === 401, `status ${emptyToken.status}`);

    const bearer = await fetch(`${base}/api/recovery/drafts`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    check("Authorization: Bearer token is accepted", bearer.status === 200, `status ${bearer.status}`);

    // ---- list summaries ----
    const listRes = await fetch(`${base}/api/recovery/drafts?token=${encodeURIComponent(TOKEN)}`);
    const listText = await listRes.text();
    const list = JSON.parse(listText);
    check("query token is accepted", listRes.status === 200 && list.ok === true);
    check("list reports the total row count", list.total_drafts === 3, `total ${list.total_drafts}`);
    check("list returns every draft", list.drafts.length === 3, `returned ${list.drafts.length}`);
    check(
      "list is ordered newest-updated first",
      list.drafts[0].access_code_hash_prefix === denisHash.slice(0, 12) &&
        list.drafts[0].tax_year === 2025,
      JSON.stringify(list.drafts.map((d) => [d.tax_year, d.access_code_hash_prefix])),
    );

    const denis2026 = list.drafts.find(
      (d) => d.tax_year === YEAR && d.access_code_hash_prefix === denisHash.slice(0, 12),
    );
    check("summary exposes trip_count", denis2026 && denis2026.trip_count === 3, JSON.stringify(denis2026));
    check(
      "summary exposes sorted unique countries",
      denis2026 && denis2026.countries.join(",") === "Cyprus,Greece,Russia",
      denis2026 && denis2026.countries.join(","),
    );
    check(
      "summary exposes the overall date range",
      denis2026 && denis2026.earliest_date === "2026-01-10" && denis2026.latest_date === "2026-05-09",
      denis2026 && `${denis2026.earliest_date}..${denis2026.latest_date}`,
    );
    check(
      "summary previews non-empty comments only",
      denis2026 &&
        denis2026.comment_count === 2 &&
        denis2026.comments_preview.join("|") === "зимовка в Лимассоле|работа",
      denis2026 && JSON.stringify(denis2026.comments_preview),
    );
    check("summary reports updated_at", denis2026 && typeof denis2026.updated_at === "string");
    check("summary reports payload_bytes", denis2026 && denis2026.payload_bytes > 0);

    // ---- hash and payload are not leaked by default ----
    check(
      "hash prefix is truncated to 12 chars",
      denis2026 && denis2026.access_code_hash_prefix.length === 12,
      denis2026 && String(denis2026.access_code_hash_prefix.length),
    );
    check(
      "no full access_code_hash appears anywhere in the response",
      !listText.includes(denisHash),
    );
    check(
      "response carries no field named access_code_hash",
      !/"access_code_hash"/.test(listText),
    );
    check("payload is withheld by default", denis2026 && denis2026.payload === undefined);
    check("list reports include_payload=false by default", list.include_payload === false);
    check(
      "no plaintext access code is echoed back",
      !listText.includes(DENIS_CODE) && !listText.includes(OTHER_CODE),
    );

    // ---- filters ----
    const filtered = await fetch(
      `${base}/api/recovery/drafts?token=${encodeURIComponent(TOKEN)}&tax_year=2025`,
    ).then((r) => r.json());
    check(
      "tax_year filter narrows the result set",
      filtered.drafts.length === 1 && filtered.drafts[0].tax_year === 2025,
      JSON.stringify(filtered.drafts.map((d) => d.tax_year)),
    );

    const byPrefix = await fetch(
      `${base}/api/recovery/drafts?token=${encodeURIComponent(TOKEN)}&hash_prefix=${denisHash.slice(0, 12)}`,
    ).then((r) => r.json());
    check(
      "hash_prefix filter selects a single workspace",
      byPrefix.drafts.length === 2 &&
        byPrefix.drafts.every((d) => d.access_code_hash_prefix === denisHash.slice(0, 12)),
      JSON.stringify(byPrefix.drafts.map((d) => d.tax_year)),
    );

    const badPrefix = await fetch(
      `${base}/api/recovery/drafts?token=${encodeURIComponent(TOKEN)}&hash_prefix=not-hex%25`,
    );
    check("non-hex hash_prefix is rejected", badPrefix.status === 400, `status ${badPrefix.status}`);

    const badYear = await fetch(
      `${base}/api/recovery/drafts?token=${encodeURIComponent(TOKEN)}&tax_year=abc`,
    );
    check("invalid tax_year is rejected", badYear.status === 400, `status ${badYear.status}`);

    const limited = await fetch(
      `${base}/api/recovery/drafts?token=${encodeURIComponent(TOKEN)}&limit=1`,
    ).then((r) => r.json());
    check("limit caps the number of rows returned", limited.drafts.length === 1);

    // ---- explicit payload opt-in ----
    const full = await fetch(
      `${base}/api/recovery/drafts?token=${encodeURIComponent(TOKEN)}&tax_year=${YEAR}&hash_prefix=${denisHash.slice(0, 12)}&include_payload=1`,
    ).then((r) => r.json());
    check(
      "include_payload=1 returns the full payload",
      full.drafts.length === 1 && full.drafts[0].payload.trips.length === 3,
      JSON.stringify(full.drafts[0] && full.drafts[0].payload),
    );
    check("include_payload=1 is reported back", full.include_payload === true);

    // ---- copy onto a key the browser still has ----
    const badTarget = await copy(base, {
      token: TOKEN,
      source_hash_prefix: denisHash.slice(0, 12),
      target_access_code: "short",
      tax_year: YEAR,
    });
    check("copy rejects a too-short target_access_code", badTarget.status === 400, `status ${badTarget.status}`);

    const missingSource = await copy(base, {
      token: TOKEN,
      source_hash_prefix: "ffffffffffff",
      target_access_code: RECOVER_CODE,
      tax_year: YEAR,
    });
    check("copy 404s on an unknown source prefix", missingSource.status === 404, `status ${missingSource.status}`);

    const unauthedCopy = await copy(base, {
      source_hash_prefix: denisHash.slice(0, 12),
      target_access_code: RECOVER_CODE,
      tax_year: YEAR,
    });
    check("copy without a token is 401", unauthedCopy.status === 401, `status ${unauthedCopy.status}`);

    const selfCopy = await copy(base, {
      token: TOKEN,
      source_hash_prefix: denisHash.slice(0, 12),
      target_access_code: DENIS_CODE,
      tax_year: YEAR,
    });
    check("copy refuses a target that resolves to the source", selfCopy.status === 400, `status ${selfCopy.status}`);

    const copyRes = await copy(
      base,
      {
        source_hash_prefix: denisHash.slice(0, 12),
        target_access_code: RECOVER_CODE,
        tax_year: YEAR,
      },
      { Authorization: `Bearer ${TOKEN}` },
    );
    const copyJson = await copyRes.json();
    check("copy succeeds with a bearer token", copyRes.status === 200 && copyJson.ok === true, JSON.stringify(copyJson));
    check("copy reports the trip count it moved", copyJson.trip_count === 3, JSON.stringify(copyJson));
    check("copy reports overwritten=false for a fresh target", copyJson.overwritten === false);
    check(
      "copy response leaks no full hash and no target plaintext",
      !JSON.stringify(copyJson).includes(denisHash) && !JSON.stringify(copyJson).includes(RECOVER_CODE),
      JSON.stringify(copyJson),
    );

    const recovered = await fetch(
      `${base}/api/draft?access_code=${encodeURIComponent(RECOVER_CODE)}&tax_year=${YEAR}`,
    ).then((r) => r.json());
    check(
      "the target access code now loads the recovered trips",
      recovered.found === true && recovered.payload.trips.length === 3,
      JSON.stringify(recovered.payload && recovered.payload.trips),
    );
    check(
      "recovered payload matches the source trips exactly",
      JSON.stringify(recovered.payload.trips) === JSON.stringify(DENIS_TRIPS),
      JSON.stringify(recovered.payload.trips),
    );

    const sourceStillThere = await fetch(
      `${base}/api/draft?access_code=${encodeURIComponent(DENIS_CODE)}&tax_year=${YEAR}`,
    ).then((r) => r.json());
    check(
      "copy leaves the source draft intact",
      sourceStillThere.found === true && sourceStillThere.payload.trips.length === 3,
    );

    // ---- overwrite guard ----
    const clobber = await copy(base, {
      token: TOKEN,
      source_hash_prefix: hashCode(OTHER_CODE).slice(0, 12),
      target_access_code: RECOVER_CODE,
      tax_year: YEAR,
    });
    check(
      "copy onto an existing target needs overwrite=1",
      clobber.status === 409,
      `status ${clobber.status}`,
    );
    const stillDenis = await fetch(
      `${base}/api/draft?access_code=${encodeURIComponent(RECOVER_CODE)}&tax_year=${YEAR}`,
    ).then((r) => r.json());
    check("blocked copy did not touch the target draft", stillDenis.payload.trips.length === 3);

    const forced = await copy(base, {
      token: TOKEN,
      source_hash_prefix: hashCode(OTHER_CODE).slice(0, 12),
      target_access_code: RECOVER_CODE,
      tax_year: YEAR,
      overwrite: "1",
    }).then((r) => r.json());
    check("overwrite=1 replaces the target draft", forced.ok === true && forced.overwritten === true, JSON.stringify(forced));
    const replaced = await fetch(
      `${base}/api/draft?access_code=${encodeURIComponent(RECOVER_CODE)}&tax_year=${YEAR}`,
    ).then((r) => r.json());
    check(
      "target now holds the second source's trips",
      replaced.payload.trips.length === 1 && replaced.payload.trips[0].trip_country === "Georgia",
      JSON.stringify(replaced.payload.trips),
    );
  } finally {
    await close(server);
  }
}

(async () => {
  try {
    await phaseDisabled();
    await phaseShortToken();
    await phaseEnabled();
  } catch (err) {
    failures++;
    console.log("  FAIL harness error —", err.stack || err.message);
  }

  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch (_) {
    // best effort
  }
  if (failures) {
    console.log(`\n${failures} recovery check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll recovery checks passed.");
  process.exit(0);
})();
