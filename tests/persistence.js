// Browser-level persistence tests: boots the real frontend (public/index.html +
// calc.js + app.js) inside jsdom against a live server and a temporary SQLite DB.
//
// These cover the autosave-vs-initial-load ordering, which is where a blank
// startup form can otherwise be POSTed over an existing cloud draft.
//
// Run with: npm test

const fs = require("fs");
const os = require("os");
const path = require("path");
const { JSDOM } = require("jsdom");

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cyprus-60-persist-"));
process.env.DB_PATH = path.join(tmpDir, "data.db");
process.env.API_RATE_LIMIT_DISABLED = "1";

const ROOT = path.join(__dirname, "..");
const { app } = require(path.join(ROOT, "server.js"));

const html = fs.readFileSync(path.join(ROOT, "public/index.html"), "utf8");
const calcSrc = fs.readFileSync(path.join(ROOT, "public/calc.js"), "utf8");
const appSrc = fs.readFileSync(path.join(ROOT, "public/app.js"), "utf8");

const YEAR = 2026;
const AUTOSAVE_DEBOUNCE_MS = 1000;
const SETTLE_MS = AUTOSAVE_DEBOUNCE_MS + 600;
const SEEDED_TRIPS = [
  { trip_country: "Cyprus", date_arrival: "2026-01-10", date_departure: "2026-03-20", day_type: "stay", comment: "winter" },
  { trip_country: "Russia", date_arrival: "2026-04-01", date_departure: "2026-04-15", day_type: "stay", comment: "work" },
];

let failures = 0;
function check(name, cond, detail) {
  if (cond) {
    console.log(`  ok  ${name}`);
  } else {
    failures++;
    console.log(`  FAIL ${name}${detail ? " — " + detail : ""}`);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let keySeq = 0;
const freshKey = () => `wsteskey${String(++keySeq).padStart(4, "0")}abcdefghij`;

function cookieFor(key, year = YEAR) {
  return `cyprus60_workspace=${encodeURIComponent(JSON.stringify({ key, year }))}`;
}

// Boots the real frontend. `fetchMode` shapes the GET /api/draft response so the
// initial-load failure and slow-load paths can be exercised deterministically.
function boot(base, url, { cookie, fetchMode = "normal" } = {}) {
  const dom = new JSDOM(html, { url, runScripts: "outside-only", pretendToBeVisual: true });
  const win = dom.window;
  if (cookie) win.document.cookie = cookie;

  const requests = [];
  win.fetch = (input, init = {}) => {
    const target = new win.URL(input, base).toString();
    const method = (init.method || "GET").toUpperCase();
    requests.push(`${method} ${target.replace(base, "")}`);
    const isDraftGet = method === "GET" && target.includes("/api/draft");
    if (isDraftGet && fetchMode === "slow") {
      // Resolves after the autosave debounce would have fired.
      return sleep(AUTOSAVE_DEBOUNCE_MS + 1200).then(() => fetch(target, init));
    }
    if (isDraftGet && fetchMode === "httpError") {
      return Promise.resolve({
        ok: false,
        status: 429,
        statusText: "Too Many Requests",
        json: async () => ({ ok: false, error: "rate limit exceeded" }),
      });
    }
    if (isDraftGet && fetchMode === "netFail") {
      return Promise.reject(new Error("network down"));
    }
    return fetch(target, init);
  };
  win.crypto = win.crypto || require("crypto").webcrypto;
  win.confirm = () => true;
  // jsdom performs no layout; render() calls scrollIntoView on the results card.
  win.Element.prototype.scrollIntoView = function () {};

  win.eval(calcSrc);
  win.eval(appSrc);
  return { win, requests };
}

function tripCountries(win) {
  return [...win.document.querySelectorAll("#trips-body tr")]
    .map((tr) => tr.querySelector(".trip-country")?.value || "")
    .filter(Boolean);
}

function typeInto(win, selector, value) {
  const el = win.document.querySelector(selector);
  el.value = value;
  el.dispatchEvent(new win.Event("input", { bubbles: true }));
}

function fillFirstTrip(win, country) {
  typeInto(win, "#trips-body .trip-country", country);
  typeInto(win, "#trips-body .trip-arrival", "2026-06-01");
  typeInto(win, "#trips-body .trip-departure", "2026-06-10");
}

const server = app.listen(0, "127.0.0.1", async () => {
  const base = `http://127.0.0.1:${server.address().port}`;

  const seed = async (key, trips = SEEDED_TRIPS) => {
    const res = await fetch(`${base}/api/draft`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ access_code: key, payload: { tax_year: YEAR, trips } }),
    });
    if (!res.ok) throw new Error(`seed failed: ${res.status}`);
  };
  const stored = async (key) => {
    const d = await fetch(
      `${base}/api/draft?access_code=${encodeURIComponent(key)}&tax_year=${YEAR}`,
    ).then((r) => r.json());
    return d.found ? d.payload : null;
  };
  const storedTripCount = async (key) => {
    const p = await stored(key);
    return p && Array.isArray(p.trips) ? p.trips.length : -1;
  };

  try {
    // ---- A tracking query string must not disturb the workspace ----
    {
      const key = freshKey();
      await seed(key);
      const { win, requests } = boot(base, `${base}/?utm_source=perplexity`, { cookie: cookieFor(key) });
      await sleep(400);
      check(
        "utm query: existing cloud draft still loads into the form",
        tripCountries(win).join(",") === "Cyprus,Russia",
        tripCountries(win).join(","),
      );
      check(
        "utm query: cookie workspace key is reused, not regenerated",
        win.document.cookie.includes(key),
      );
      check(
        "utm query: page load issues no POST (nothing overwritten)",
        !requests.some((r) => r.startsWith("POST")),
        requests.join(" | "),
      );
      check("utm query: stored draft still has both trips", (await storedTripCount(key)) === 2);
    }

    // ---- Autosave must not fire before the initial load resolves ----
    {
      const key = freshKey();
      await seed(key);
      const { win } = boot(base, `${base}/`, { cookie: cookieFor(key), fetchMode: "slow" });
      await sleep(50);
      fillFirstTrip(win, "Greece"); // user types while the load is still in flight
      await sleep(SETTLE_MS);
      check(
        "slow initial load: blank form is not saved over the existing draft",
        (await storedTripCount(key)) === 2,
        `stored trips = ${await storedTripCount(key)}`,
      );
      await sleep(1200); // let the slow load land
      check(
        "slow initial load: draft still arrives in the form afterwards",
        tripCountries(win).join(",") === "Cyprus,Russia",
        tripCountries(win).join(","),
      );
    }

    // ---- A failed initial load must not license a blank overwrite ----
    {
      const key = freshKey();
      await seed(key);
      const { win, requests } = boot(base, `${base}/`, { cookie: cookieFor(key), fetchMode: "httpError" });
      await sleep(200);
      fillFirstTrip(win, "Greece");
      await sleep(SETTLE_MS);
      check(
        "failed initial load (429): later edits do not overwrite the draft",
        (await storedTripCount(key)) === 2,
        `stored trips = ${await storedTripCount(key)}`,
      );
      check(
        "failed initial load (429): no POST is attempted at all",
        !requests.some((r) => r.startsWith("POST")),
        requests.join(" | "),
      );
      check(
        "failed initial load (429): status explains autosave is paused",
        /Автосохранение приостановлено/.test(win.document.querySelector(".cloud-status-text").textContent),
        win.document.querySelector(".cloud-status-text").textContent,
      );
    }

    // ---- Same protection for the Calculate button's immediate save ----
    {
      const key = freshKey();
      await seed(key);
      const { win } = boot(base, `${base}/`, { cookie: cookieFor(key), fetchMode: "netFail" });
      await sleep(200);
      win.document.querySelector("#calculate").dispatchEvent(new win.Event("click", { bubbles: true }));
      await sleep(600);
      check(
        "failed initial load: Calculate does not flush a blank payload",
        (await storedTripCount(key)) === 2,
        `stored trips = ${await storedTripCount(key)}`,
      );
    }

    // ---- Autosave still works once the cloud state is known ----
    {
      const key = freshKey();
      await seed(key);
      const { win } = boot(base, `${base}/`, { cookie: cookieFor(key) });
      await sleep(400); // load completes
      typeInto(win, "#trips-body tr:last-child .trip-country", "Greece");
      typeInto(win, "#trips-body tr:last-child .trip-arrival", "2026-07-01");
      typeInto(win, "#trips-body tr:last-child .trip-departure", "2026-07-05");
      await sleep(SETTLE_MS);
      const p = await stored(key);
      const countries = (p.trips || []).map((t) => t.trip_country);
      check(
        "after a successful load: edits are autosaved and merged with the draft",
        countries.includes("Cyprus") && countries.includes("Greece"),
        JSON.stringify(countries),
      );
    }

    // ---- First visit with no cookie: autosave works immediately ----
    {
      const { win } = boot(base, `${base}/?utm_source=perplexity`);
      await sleep(200);
      fillFirstTrip(win, "Cyprus");
      await sleep(SETTLE_MS);
      const raw = decodeURIComponent(win.document.cookie.split("cyprus60_workspace=")[1] || "{}");
      const mintedKey = JSON.parse(raw).key;
      check("first visit: a workspace key is minted into the cookie", typeof mintedKey === "string" && mintedKey.length >= 8);
      check(
        "first visit: typed trip is autosaved to the cloud",
        (await storedTripCount(mintedKey)) === 1,
        `stored trips = ${await storedTripCount(mintedKey)}`,
      );
    }

    // ---- Cookie present but no cloud draft yet: autosave still arms ----
    {
      const key = freshKey();
      const { win } = boot(base, `${base}/`, { cookie: cookieFor(key) });
      await sleep(300); // load resolves found=false
      fillFirstTrip(win, "Cyprus");
      await sleep(SETTLE_MS);
      check(
        "cookie with no draft yet: first edits are saved",
        (await storedTripCount(key)) === 1,
        `stored trips = ${await storedTripCount(key)}`,
      );
    }
  } catch (err) {
    failures++;
    console.log("  FAIL harness error —", err.stack);
  }

  server.close();
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch (_) {
    // best effort
  }
  if (failures) {
    console.log(`\n${failures} persistence check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll persistence checks passed.");
  process.exit(0);
});
