// Browser-level persistence tests: boots the real frontend (public/index.html +
// calc.js + app.js) inside jsdom against a live server and a temporary SQLite DB.
//
// These cover the two behaviours the app is judged on:
//   * a fresh browser with no cookie sees the one shared trip list, and edits
//     made in one browser show up in the next one;
//   * autosave never runs before the initial load resolves, which is what
//     stopped a blank startup form from being POSTed over real trips.
//
// The suite sets DEFAULT_WORKSPACE_ACCESS_CODE so it can seed and inspect the
// shared profile through the legacy per-workspace API. The frontend is never
// given that code — that asymmetry is the point of several checks below.
//
// Run with: npm test

const fs = require("fs");
const os = require("os");
const path = require("path");
const { JSDOM } = require("jsdom");

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cyprus-60-persist-"));
process.env.DB_PATH = path.join(tmpDir, "data.db");
process.env.API_RATE_LIMIT_DISABLED = "1";
const DEFAULT_CODE = "test-default-profile-code-2026";
process.env.DEFAULT_WORKSPACE_ACCESS_CODE = DEFAULT_CODE;
delete process.env.APP_ACCESS_PASSWORD;

const ROOT = path.join(__dirname, "..");
const { app } = require(path.join(ROOT, "server.js"));

const html = fs.readFileSync(path.join(ROOT, "public/index.html"), "utf8");
const calcSrc = fs.readFileSync(path.join(ROOT, "public/calc.js"), "utf8");
const appSrc = fs.readFileSync(path.join(ROOT, "public/app.js"), "utf8");

const YEAR = 2026;
const AUTOSAVE_DEBOUNCE_MS = 1000;
const SETTLE_MS = AUTOSAVE_DEBOUNCE_MS + 600;
// The frontend probes /api/auth/status before it loads, so "the load has
// resolved" is a couple of ticks later than a single fetch.
const LOAD_MS = 500;
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

// Boots the real frontend in a fresh jsdom with no cookies. `fetchMode` shapes
// the GET /api/default-draft response so the initial-load failure and slow-load
// paths can be exercised deterministically.
function boot(base, url, { fetchMode = "normal", cookie } = {}) {
  const dom = new JSDOM(html, { url, runScripts: "outside-only", pretendToBeVisual: true });
  const win = dom.window;
  if (cookie) win.document.cookie = cookie;

  const requests = [];
  win.fetch = (input, init = {}) => {
    const target = new win.URL(input, base).toString();
    const method = (init.method || "GET").toUpperCase();
    const route = target.replace(base, "");
    requests.push(`${method} ${route}`);
    // Only the draft load itself, not the versions list that shares its prefix.
    const isDraftGet = method === "GET" && /^\/api\/default-draft\?/.test(route);
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

function click(win, selector) {
  win.document.querySelector(selector).dispatchEvent(new win.Event("click", { bubbles: true }));
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

// Static guarantee, not a behavioural one: user data must live only in server
// SQLite, and the shared profile's access code must never reach the browser.
function checkStaticGuarantees() {
  console.log("\nNo browser-side storage of user data:");
  const STORAGE_API = /\b(localStorage|sessionStorage|indexedDB|openDatabase)\b/i;
  for (const [name, src] of [["app.js", appSrc], ["calc.js", calcSrc], ["index.html", html]]) {
    const offenders = src
      .split("\n")
      .map((line, i) => [i + 1, line])
      .filter(([, line]) => STORAGE_API.test(line))
      // The only tolerated mention is the comment naming the APIs app.js avoids.
      .filter(([, line]) => !line.trim().startsWith("//"));
    check(
      `${name} makes no web-storage API calls`,
      offenders.length === 0,
      offenders.map(([n, line]) => `L${n}: ${line.trim()}`).join(" | "),
    );
  }

  console.log("\nNo access code in anything the browser downloads:");
  const serverSrc = fs.readFileSync(path.join(ROOT, "server.js"), "utf8");
  const builtinDefault = /BUILTIN_DEFAULT_WORKSPACE_ACCESS_CODE = "([^"]+)"/.exec(serverSrc)[1];
  for (const [name, src] of [["app.js", appSrc], ["index.html", html]]) {
    check(`${name} does not contain the configured default access code`, !src.includes(DEFAULT_CODE));
    check(`${name} does not contain the built-in fallback access code`, !src.includes(builtinDefault));
    check(`${name} sends no access_code parameter`, !/access_code/.test(src), name);
  }
}

const server = app.listen(0, "127.0.0.1", async () => {
  const base = `http://127.0.0.1:${server.address().port}`;

  // Seeding and inspection go through the legacy API using the code the server
  // was configured with, so the frontend's view can be compared against it.
  const seed = async (trips = SEEDED_TRIPS) => {
    const res = await fetch(`${base}/api/draft`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ access_code: DEFAULT_CODE, payload: { tax_year: YEAR, trips } }),
    });
    if (!res.ok) throw new Error(`seed failed: ${res.status}`);
  };
  const reset = () =>
    fetch(`${base}/api/draft?access_code=${encodeURIComponent(DEFAULT_CODE)}&tax_year=${YEAR}`, {
      method: "DELETE",
    });
  const stored = async () => {
    const d = await fetch(
      `${base}/api/draft?access_code=${encodeURIComponent(DEFAULT_CODE)}&tax_year=${YEAR}`,
    ).then((r) => r.json());
    return d.found ? d.payload : null;
  };
  const storedTripCount = async () => {
    const p = await stored();
    return p && Array.isArray(p.trips) ? p.trips.length : -1;
  };

  try {
    checkStaticGuarantees();

    console.log("\nShared profile across fresh browsers:");

    // ---- A fresh browser with no cookie sees the shared list ----
    {
      await reset();
      await seed();
      const { win, requests } = boot(base, `${base}/`);
      await sleep(LOAD_MS);
      check(
        "fresh browser with no cookie loads the shared trip list",
        tripCountries(win).join(",") === "Cyprus,Russia",
        tripCountries(win).join(","),
      );
      check(
        "the load carries no access_code",
        requests.every((r) => !r.includes("access_code")),
        requests.join(" | "),
      );
      check(
        "no workspace cookie is written",
        !win.document.cookie.includes("cyprus60_workspace"),
        win.document.cookie,
      );
      check(
        "page load issues no POST (nothing overwritten)",
        !requests.some((r) => r.startsWith("POST")),
        requests.join(" | "),
      );
    }

    // ---- Edits in one fresh context are visible in another ----
    {
      await reset();
      const first = boot(base, `${base}/`);
      await sleep(LOAD_MS);
      fillFirstTrip(first.win, "Portugal");
      await sleep(SETTLE_MS);
      check(
        "first fresh context autosaves its edit to the server",
        (await storedTripCount()) === 1,
        `stored trips = ${await storedTripCount()}`,
      );

      const second = boot(base, `${base}/`);
      await sleep(LOAD_MS);
      check(
        "a second fresh context (no shared cookie) sees the first one's edit",
        tripCountries(second.win).join(",") === "Portugal",
        tripCountries(second.win).join(","),
      );

      // And back the other way: the second browser edits, a third one sees it.
      typeInto(second.win, "#trips-body tr:last-child .trip-comment", "из второго браузера");
      await sleep(SETTLE_MS);
      const third = boot(base, `${base}/`);
      await sleep(LOAD_MS);
      const comments = [...third.win.document.querySelectorAll("#trips-body .trip-comment")].map((el) => el.value);
      check(
        "a third fresh context sees the second one's edit",
        comments.includes("из второго браузера"),
        JSON.stringify(comments),
      );
    }

    // ---- A tracking query string must not disturb the shared list ----
    {
      await reset();
      await seed();
      const { win } = boot(base, `${base}/?utm_source=perplexity`);
      await sleep(LOAD_MS);
      check(
        "utm query: shared list still loads into the form",
        tripCountries(win).join(",") === "Cyprus,Russia",
        tripCountries(win).join(","),
      );
      check("utm query: stored list still has both trips", (await storedTripCount()) === 2);
    }

    console.log("\nAutosave and initial load:");

    // ---- Autosave must not fire before the initial load resolves ----
    {
      await reset();
      await seed();
      const { win } = boot(base, `${base}/`, { fetchMode: "slow" });
      await sleep(50);
      fillFirstTrip(win, "Greece"); // user types while the load is still in flight
      await sleep(SETTLE_MS);
      check(
        "slow initial load: blank form is not saved over the stored list",
        (await storedTripCount()) === 2,
        `stored trips = ${await storedTripCount()}`,
      );
      await sleep(1400); // let the slow load land
      check(
        "slow initial load: the list still arrives in the form afterwards",
        tripCountries(win).join(",") === "Cyprus,Russia",
        tripCountries(win).join(","),
      );
    }

    // ---- A failed initial load must not license a blank overwrite ----
    {
      await reset();
      await seed();
      const { win, requests } = boot(base, `${base}/`, { fetchMode: "httpError" });
      await sleep(300);
      fillFirstTrip(win, "Greece");
      await sleep(SETTLE_MS);
      check(
        "failed initial load (429): later edits do not overwrite the list",
        (await storedTripCount()) === 2,
        `stored trips = ${await storedTripCount()}`,
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
      await reset();
      await seed();
      const { win } = boot(base, `${base}/`, { fetchMode: "netFail" });
      await sleep(300);
      win.document.querySelector("#calculate").dispatchEvent(new win.Event("click", { bubbles: true }));
      await sleep(700);
      check(
        "failed initial load: Calculate does not flush a blank payload",
        (await storedTripCount()) === 2,
        `stored trips = ${await storedTripCount()}`,
      );
    }

    // ---- Autosave still works once the server state is known ----
    {
      await reset();
      await seed();
      const { win } = boot(base, `${base}/`);
      await sleep(LOAD_MS);
      typeInto(win, "#trips-body tr:last-child .trip-country", "Greece");
      typeInto(win, "#trips-body tr:last-child .trip-arrival", "2026-07-01");
      typeInto(win, "#trips-body tr:last-child .trip-departure", "2026-07-05");
      await sleep(SETTLE_MS);
      const p = await stored();
      const countries = (p.trips || []).map((t) => t.trip_country);
      check(
        "after a successful load: edits are autosaved and merged with the list",
        countries.includes("Cyprus") && countries.includes("Greece"),
        JSON.stringify(countries),
      );
    }

    // ---- Nothing stored yet: autosave still arms ----
    {
      await reset();
      const { win } = boot(base, `${base}/`);
      await sleep(LOAD_MS); // load resolves found=false
      fillFirstTrip(win, "Cyprus");
      await sleep(SETTLE_MS);
      check(
        "empty profile: first edits are saved",
        (await storedTripCount()) === 1,
        `stored trips = ${await storedTripCount()}`,
      );
    }

    // ---- Recovering from an overwrite through the archive UI ----
    // Replays Denis's incident: good trips existed, something wrote a blank
    // list over them, and the user has to get them back without an admin.
    {
      console.log("\nArchive UI (Архив поездок):");
      await reset();
      await seed();        // Cyprus + Russia
      await seed([]);      // the accident: a blank payload lands on top

      const { win, requests } = boot(base, `${base}/`);
      await sleep(LOAD_MS);
      check(
        "the overwritten list loads as an empty form",
        tripCountries(win).length === 0,
        tripCountries(win).join(","),
      );

      // The archive is reachable straight from the main bar — no advanced
      // panel, no token, no access code.
      click(win, "#cloud-history-toggle");
      await sleep(400);

      check(
        "the archive panel opens from the main bar",
        !win.document.querySelector("#cloud-history").hasAttribute("hidden"),
      );
      check(
        "the live list is shown as the current version",
        Boolean(win.document.querySelector(".cloud-history-item.is-current")),
      );

      const restoreButtons = [...win.document.querySelectorAll(".cloud-history-restore")];
      check("the overwritten version is offered for restore", restoreButtons.length === 1, `buttons = ${restoreButtons.length}`);
      const facts = win.document.querySelector(".cloud-history-item:not(.is-current) .cloud-history-facts");
      check(
        "the entry describes trip count, countries and date range",
        /2 поездки/.test(facts.textContent) &&
          /Cyprus, Russia/.test(facts.textContent) &&
          /2026-01-10 — 2026-04-15/.test(facts.textContent),
        facts.textContent,
      );
      const comments = win.document.querySelector(".cloud-history-item:not(.is-current) .cloud-history-comments");
      check("the entry previews the comments", /winter/.test(comments.textContent), comments.textContent);

      const postsBefore = requests.filter((r) => r === "POST /api/default-draft").length;
      restoreButtons[0].dispatchEvent(new win.Event("click", { bubbles: true }));
      await sleep(600);

      check(
        "restore hydrates the recovered trips back into the form",
        tripCountries(win).join(",") === "Cyprus,Russia",
        tripCountries(win).join(","),
      );
      check("restore makes the recovered list current on the server", (await storedTripCount()) === 2, `stored trips = ${await storedTripCount()}`);
      check(
        "status reports the restore",
        /Восстановлена версия/.test(win.document.querySelector(".cloud-status-text").textContent),
        win.document.querySelector(".cloud-status-text").textContent,
      );
      check(
        "the results table was recalculated from the restored trips",
        win.document.querySelectorAll("#trips-body tr").length === 2,
      );

      await sleep(SETTLE_MS);
      check(
        "hydrating the restored list does not autosave over it",
        requests.filter((r) => r === "POST /api/default-draft").length === postsBefore,
        requests.filter((r) => r.startsWith("POST")).join(" | "),
      );
      check("the restored trips are still on the server after settling", (await storedTripCount()) === 2);

      const history = await fetch(
        `${base}/api/draft/versions?access_code=${encodeURIComponent(DEFAULT_CODE)}&tax_year=${YEAR}`,
      ).then((r) => r.json());
      check(
        "the blank list the restore replaced is itself restorable",
        history.versions.some((v) => v.trip_count === 0 && v.source === "restore"),
        JSON.stringify(history.versions.map((v) => [v.trip_count, v.source])),
      );

      // Editing after a restore must still autosave normally.
      typeInto(win, "#trips-body tr:last-child .trip-comment", "после восстановления");
      await sleep(SETTLE_MS);
      const after = await stored();
      check(
        "autosave keeps working after a restore",
        after.trips.some((t) => t.comment === "после восстановления"),
        JSON.stringify(after.trips.map((t) => t.comment)),
      );
    }

    // ---- Clearing the list stays reversible ----
    {
      console.log("\nClearing the list:");
      await reset();
      await seed();
      const { win } = boot(base, `${base}/`);
      await sleep(LOAD_MS);
      click(win, "#cloud-clear-trips");
      await sleep(600);
      check("clearing empties the stored list", (await storedTripCount()) === 0, `stored trips = ${await storedTripCount()}`);
      const history = await fetch(
        `${base}/api/draft/versions?access_code=${encodeURIComponent(DEFAULT_CODE)}&tax_year=${YEAR}`,
      ).then((r) => r.json());
      check(
        "the cleared list is recoverable from the archive",
        history.versions.some((v) => v.trip_count === 2),
        JSON.stringify(history.versions.map((v) => v.trip_count)),
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
