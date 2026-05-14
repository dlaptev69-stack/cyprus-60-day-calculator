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
process.env.API_RATE_LIMIT_DISABLED = "1"; // don't throttle back-to-back smoke calls

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

    const sevenChar = await fetch(`${base}/api/draft`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ access_code: "1234567", payload }),
    });
    check("validation rejects 7-char access_code (new 8-char minimum)", sevenChar.status === 400);

    const eightChar = await fetch(`${base}/api/draft`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ access_code: "12345678", payload }),
    });
    check("validation accepts exactly 8-char access_code", eightChar.status === 200);

    const indexRes = await fetch(`${base}/`);
    const indexText = await indexRes.text();
    check("/ serves index.html from public/", indexRes.status === 200);
    check(
      "index advertises auto-save status row in Russian",
      indexText.includes("Автосохранение включено"),
    );
    check(
      "index has private-link copy action",
      indexText.includes("Скопировать приватную ссылку"),
    );
    check(
      "index has cloud explainer about private link",
      indexText.includes("Ссылку никому не пересылай"),
    );
    check(
      "manual access-code input is removed from the UI",
      !indexText.includes('id="cloud_access_code"'),
    );

    const appJsText = await (await fetch(`${base}/app.js`)).text();
    // Match actual API usage (foo.x, foo[, foo(, foo=) — not comments.
    check(
      "frontend does NOT use localStorage/sessionStorage/indexedDB",
      !/\b(localStorage|sessionStorage|indexedDB)\s*(?:\.|\[|\()/.test(appJsText),
    );
    check(
      "frontend auto-generates a workspace key with crypto.getRandomValues",
      appJsText.includes("generateWorkspaceKey") && appJsText.includes("crypto.getRandomValues"),
    );
    check(
      "frontend uses cookie-based workspace store (not localStorage)",
      appJsText.includes("WORKSPACE_COOKIE") && appJsText.includes("document.cookie"),
    );
    check(
      "frontend has debounced cloud autosave",
      appJsText.includes("scheduleAutosave") && appJsText.includes("AUTOSAVE_DEBOUNCE_MS"),
    );
    check(
      "frontend parses workspace from URL hash for cross-device handoff",
      appJsText.includes("parseHashWorkspace") && appJsText.includes("workspace"),
    );
    check(
      "frontend strips workspace key from the visible URL after import",
      appJsText.includes("stripWorkspaceFromUrl"),
    );
    check(
      "frontend builds a private link with workspace + year in hash",
      appJsText.includes("buildPrivateLink"),
    );

    const stylesRes = await fetch(`${base}/styles.css`);
    check("/styles.css served (200)", stylesRes.status === 200);
    const appRes = await fetch(`${base}/app.js`);
    check("/app.js served (200)", appRes.status === 200);
    const calcRes = await fetch(`${base}/calc.js`);
    check("/calc.js served (200)", calcRes.status === 200);

    const serverJs = await fetch(`${base}/server.js`);
    check("/server.js is NOT publicly served", serverJs.status === 404);
    const pkg = await fetch(`${base}/package.json`);
    check("/package.json is NOT publicly served", pkg.status === 404);
    const nodeMod = await fetch(`${base}/node_modules/express/package.json`);
    check("/node_modules/* is NOT publicly served", nodeMod.status === 404);

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
