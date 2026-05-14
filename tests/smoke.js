// End-to-end smoke test: boots the server against a temporary SQLite database,
// exercises the API, then tears the DB file down.
//
// Run with: npm test

const fs = require("fs");
const os = require("os");
const path = require("path");

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cyprus-60-test-"));
const dbFile = path.join(tmpDir, "data.db");
process.env.DB_PATH = dbFile;
process.env.PORT = "0"; // ask OS for a free port

const { app } = require("../server.js");

let failures = 0;
function check(name, cond, detail) {
  if (cond) {
    console.log(`  ok  ${name}`);
  } else {
    failures++;
    console.log(`  FAIL ${name}${detail ? " — " + detail : ""}`);
  }
}

const server = app.listen(0, "127.0.0.1", async () => {
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;
  const code = "smoke-test-code-2026";
  const year = 2026;

  try {
    const health = await fetch(`${base}/api/health`).then((r) => r.json());
    check("health responds ok", health.ok === true);

    const empty = await fetch(
      `${base}/api/draft?access_code=${encodeURIComponent(code)}&tax_year=${year}`,
    ).then((r) => r.json());
    check("load returns found=false when no draft", empty.ok && empty.found === false);

    const payload = {
      tax_year: year,
      has_cyprus_home: "yes",
      has_cyprus_business_or_employment_or_directorship: "yes",
      possible_tax_resident_elsewhere: "no",
      settings: {
        arrival_day_counts_for_cyprus: true,
        departure_day_counts_for_cyprus: false,
        same_day_arrival_departure_counts_for_cyprus: true,
        same_day_departure_return_counts_for_cyprus: false,
        transit_day_counts_for_cyprus: false,
        arrival_day_counts_other_countries: true,
        departure_day_counts_other_countries: false,
      },
      trips: [
        { trip_country: "Cyprus", date_arrival: "2026-01-01", date_departure: "2026-03-01", day_type: "stay", comment: "" },
        { trip_country: "Russia", date_arrival: "2026-04-01", date_departure: "2026-05-01", day_type: "stay", comment: "work" },
      ],
    };

    const saved = await fetch(`${base}/api/draft`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ access_code: code, payload }),
    }).then((r) => r.json());
    check("save returns ok with updated_at", saved.ok === true && typeof saved.updated_at === "string");

    const loaded = await fetch(
      `${base}/api/draft?access_code=${encodeURIComponent(code)}&tax_year=${year}`,
    ).then((r) => r.json());
    check("load round-trips trips array", loaded.ok && loaded.found === true && Array.isArray(loaded.payload.trips) && loaded.payload.trips.length === 2);
    check("load round-trips tax_year", loaded.payload.tax_year === year);
    check("load round-trips settings", loaded.payload.settings.arrival_day_counts_for_cyprus === true);

    const wrongCode = await fetch(
      `${base}/api/draft?access_code=different-code-xyz&tax_year=${year}`,
    ).then((r) => r.json());
    check("different code → no draft (data is isolated)", wrongCode.ok && wrongCode.found === false);

    const badRes = await fetch(`${base}/api/draft`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ access_code: code, payload: { tax_year: "not-a-year" } }),
    });
    const badJson = await badRes.json();
    check("validation rejects bad tax_year", badRes.status === 400 && badJson.ok === false);

    const tooShort = await fetch(`${base}/api/draft`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ access_code: "ab", payload }),
    });
    check("validation rejects too-short access_code", tooShort.status === 400);

    const del = await fetch(
      `${base}/api/draft?access_code=${encodeURIComponent(code)}&tax_year=${year}`,
      { method: "DELETE" },
    ).then((r) => r.json());
    check("delete reports 1 row removed", del.ok && del.deleted === 1);

    const gone = await fetch(
      `${base}/api/draft?access_code=${encodeURIComponent(code)}&tax_year=${year}`,
    ).then((r) => r.json());
    check("load after delete returns found=false", gone.ok && gone.found === false);
  } catch (err) {
    failures++;
    console.log(`  FAIL exception: ${err.stack || err.message}`);
  } finally {
    server.close(() => {
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch (_) {}
      if (failures === 0) {
        console.log("\nAll smoke checks passed.");
        process.exit(0);
      } else {
        console.log(`\n${failures} smoke check(s) failed.`);
        process.exit(1);
      }
    });
  }
});
