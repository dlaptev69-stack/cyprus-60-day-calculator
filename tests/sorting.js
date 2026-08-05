// Trip ordering tests: the trip list must always be sorted ascending by
// date_arrival, then date_departure, with a stable fallback that preserves the
// original relative order for identical or missing dates.
//
// Three layers are covered, because sorting has to hold at each of them:
//   * the pure comparator and calculateCyprusResidency() in public/calc.js;
//   * the server, so a stored cloud draft is sorted even if a caller posts
//     trips out of order;
//   * the real frontend in jsdom, so the visible table is sorted on server
//     load, after a date field is edited, and in the autosaved payload.
//
// Run with: npm test

const fs = require("fs");
const os = require("os");
const path = require("path");
const { JSDOM } = require("jsdom");

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cyprus-60-sorting-"));
process.env.DB_PATH = path.join(tmpDir, "data.db");
process.env.API_RATE_LIMIT_DISABLED = "1";
const DEFAULT_CODE = "test-sorting-profile-code-2026";
process.env.DEFAULT_WORKSPACE_ACCESS_CODE = DEFAULT_CODE;
delete process.env.APP_ACCESS_PASSWORD;

const ROOT = path.join(__dirname, "..");
const { app } = require(path.join(ROOT, "server.js"));
const { calculateCyprusResidency, sortTripsByDate } = require(path.join(ROOT, "public/calc.js"));

const html = fs.readFileSync(path.join(ROOT, "public/index.html"), "utf8");
const calcSrc = fs.readFileSync(path.join(ROOT, "public/calc.js"), "utf8");
const appSrc = fs.readFileSync(path.join(ROOT, "public/app.js"), "utf8");

const YEAR = 2026;
const AUTOSAVE_DEBOUNCE_MS = 1000;
const SETTLE_MS = AUTOSAVE_DEBOUNCE_MS + 600;
const LOAD_MS = 500;

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

function trip(country, arrival, departure, comment = "") {
  return {
    trip_country: country,
    date_arrival: arrival,
    date_departure: departure,
    day_type: "stay",
    comment,
  };
}

function order(trips) {
  return trips.map((t) => `${t.date_arrival || "—"}/${t.date_departure || "—"}${t.comment ? ":" + t.comment : ""}`).join(" | ");
}

// ---------------------------------------------------------------- calc layer
function calcChecks() {
  console.log("\nsortTripsByDate():");

  {
    const input = [
      trip("Greece", "2026-06-01", "2026-06-10"),
      trip("Cyprus", "2026-01-10", "2026-03-20"),
      trip("Russia", "2026-04-01", "2026-04-15"),
    ];
    const sorted = sortTripsByDate(input);
    check(
      "out-of-order trips are sorted ascending by arrival",
      sorted.map((t) => t.trip_country).join(",") === "Cyprus,Russia,Greece",
      order(sorted),
    );
    check(
      "the input array is not mutated",
      input.map((t) => t.trip_country).join(",") === "Greece,Cyprus,Russia",
      order(input),
    );
  }

  {
    const sorted = sortTripsByDate([
      trip("Cyprus", "2026-02-01", "2026-02-20", "longer"),
      trip("Cyprus", "2026-02-01", "2026-02-05", "shorter"),
    ]);
    check(
      "equal arrivals are ordered by departure",
      sorted.map((t) => t.comment).join(",") === "shorter,longer",
      order(sorted),
    );
  }

  {
    const sorted = sortTripsByDate([
      trip("Cyprus", "", "", "blank-first"),
      trip("Greece", "2026-05-01", "2026-05-10", "dated"),
      trip("Latvia", "", "2026-07-01", "no-arrival"),
      trip("Turkey", "", "", "blank-second"),
    ]);
    check(
      "trips without an arrival date sink to the end, ordered by departure, then original order",
      sorted.map((t) => t.comment).join(",") === "dated,no-arrival,blank-first,blank-second",
      order(sorted),
    );
  }

  {
    const sorted = sortTripsByDate([
      trip("Cyprus", "not-a-date", "2026-02-05", "garbage"),
      trip("Greece", "2026-03-01", "2026-03-05", "valid"),
      trip("Spain", "2026-02-30", "2026-03-02", "impossible-day"),
    ]);
    check(
      "unparseable dates are treated as missing and keep their relative order",
      sorted.map((t) => t.comment).join(",") === "valid,garbage,impossible-day",
      order(sorted),
    );
  }

  {
    const identical = [
      trip("Cyprus", "2026-01-01", "2026-01-05", "a"),
      trip("Cyprus", "2026-01-01", "2026-01-05", "b"),
      trip("Cyprus", "2026-01-01", "2026-01-05", "c"),
    ];
    check(
      "identical dates preserve the original relative order (stable)",
      sortTripsByDate(identical).map((t) => t.comment).join(",") === "a,b,c",
      order(sortTripsByDate(identical)),
    );
  }

  check("a missing trips array sorts to an empty list", sortTripsByDate(undefined).length === 0);

  console.log("\ncalculateCyprusResidency() ordering:");

  const base = {
    tax_year: YEAR,
    has_cyprus_home: "yes",
    has_cyprus_business_or_employment_or_directorship: "yes",
    possible_tax_resident_elsewhere: "no",
  };
  const shuffled = [
    trip("Greece", "2026-08-01", "2026-08-11", "greece"),
    trip("Cyprus", "2026-01-01", "2026-03-02", "cyprus"),
    trip("Russia", "2026-04-01", "2026-04-15", "russia"),
  ];
  const chronological = [shuffled[1], shuffled[2], shuffled[0]];
  const fromShuffled = calculateCyprusResidency({ ...base, trips: shuffled });
  const fromSorted = calculateCyprusResidency({ ...base, trips: chronological });

  check(
    "trips_table comes back in chronological order",
    fromShuffled.trips_table.map((t) => t.date_arrival).join(",") === "2026-01-01,2026-04-01,2026-08-01",
    fromShuffled.trips_table.map((t) => t.date_arrival).join(","),
  );
  check(
    "trip_index follows the sorted order",
    fromShuffled.trips_table.every((t, i) => t.trip_index === i),
    JSON.stringify(fromShuffled.trips_table.map((t) => t.trip_index)),
  );
  check(
    "a shuffled input produces the same result as a pre-sorted one",
    JSON.stringify(fromShuffled) === JSON.stringify(fromSorted),
  );
  check("Cyprus day count is unaffected by input order", fromShuffled.cyprus_days === 60, String(fromShuffled.cyprus_days));

  {
    const withBlank = calculateCyprusResidency({
      ...base,
      trips: [trip("Cyprus", "", "", "empty row"), trip("Cyprus", "2026-01-01", "2026-03-02", "real")],
    });
    check(
      "a row with missing dates is placed last in trips_table",
      withBlank.trips_table.map((t) => t.comment).join(",") === "real,empty row",
      withBlank.trips_table.map((t) => t.comment).join(","),
    );
    check(
      "the incomplete row is still reported as invalid",
      withBlank.trips_table[1].valid === false && withBlank.errors.some((e) => e.trip_index === 1),
      JSON.stringify(withBlank.errors),
    );
  }
}

// -------------------------------------------------------------- jsdom harness
function boot(base, url) {
  const dom = new JSDOM(html, { url, runScripts: "outside-only", pretendToBeVisual: true });
  const win = dom.window;
  win.fetch = (input, init = {}) => fetch(new win.URL(input, base).toString(), init);
  win.crypto = win.crypto || require("crypto").webcrypto;
  win.confirm = () => true;
  win.Element.prototype.scrollIntoView = function () {};
  win.eval(calcSrc);
  win.eval(appSrc);
  return win;
}

function rowDates(win) {
  return [...win.document.querySelectorAll("#trips-body tr")]
    .map((tr) => tr.querySelector(".trip-arrival")?.value || "—")
    .join(",");
}

function rowCountries(win) {
  return [...win.document.querySelectorAll("#trips-body tr")]
    .map((tr) => tr.querySelector(".trip-country")?.value || "—")
    .join(",");
}

const server = app.listen(0, "127.0.0.1", async () => {
  const base = `http://127.0.0.1:${server.address().port}`;

  const seed = async (trips) => {
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

  try {
    calcChecks();

    console.log("\nServer stores drafts sorted:");
    {
      await reset();
      await seed([
        trip("Greece", "2026-09-01", "2026-09-10", "later"),
        trip("Cyprus", "2026-01-05", "2026-01-25", "earlier"),
        trip("Turkey", "", "", "no dates"),
      ]);
      const payload = await stored();
      check(
        "a draft posted out of order is stored sorted",
        payload.trips.map((t) => t.comment).join(",") === "earlier,later,no dates",
        order(payload.trips),
      );
      const defaultDraft = await fetch(`${base}/api/default-draft?tax_year=${YEAR}`).then((r) => r.json());
      check(
        "the shared default profile serves the same sorted list",
        defaultDraft.found && defaultDraft.payload.trips.map((t) => t.comment).join(",") === "earlier,later,no dates",
        JSON.stringify(defaultDraft.payload && defaultDraft.payload.trips),
      );
    }

    console.log("\nFrontend ordering:");
    {
      await reset();
      // The server already sorts on save, so the frontend is checked against a
      // sorted list plus a live edit that has to move a row on its own.
      await seed([
        trip("Greece", "2026-09-01", "2026-09-10", "later"),
        trip("Cyprus", "2026-01-05", "2026-01-25", "earlier"),
      ]);
      const win = boot(base, `${base}/`);
      await sleep(LOAD_MS);
      check(
        "server-loaded trips are displayed in chronological order",
        rowCountries(win) === "Cyprus,Greece",
        rowCountries(win),
      );

      // Editing the last row's arrival to the earliest date moves it to the top.
      const lastRow = [...win.document.querySelectorAll("#trips-body tr")].pop();
      const arrival = lastRow.querySelector(".trip-arrival");
      arrival.value = "2025-12-01";
      arrival.dispatchEvent(new win.Event("change", { bubbles: true }));
      check(
        "editing an arrival date re-sorts the table immediately",
        rowCountries(win) === "Greece,Cyprus" && rowDates(win) === "2025-12-01,2026-01-05",
        `${rowCountries(win)} / ${rowDates(win)}`,
      );

      await sleep(SETTLE_MS);
      const payload = await stored();
      check(
        "the autosaved payload is sorted",
        payload.trips.map((t) => t.date_arrival).join(",") === "2025-12-01,2026-01-05",
        order(payload.trips),
      );
    }

    {
      // A newly added blank row must not jump above the dated rows, and the
      // calculation must line up with what the table shows.
      await reset();
      await seed([
        trip("Cyprus", "2026-02-01", "2026-04-02", "cyprus"),
        trip("Russia", "2026-05-01", "2026-05-10", "russia"),
      ]);
      const win = boot(base, `${base}/`);
      await sleep(LOAD_MS);
      win.document.querySelector("#add-trip").dispatchEvent(new win.Event("click", { bubbles: true }));
      check(
        "a freshly added blank row stays at the bottom",
        rowCountries(win) === "Cyprus,Russia,—",
        rowCountries(win),
      );

      win.document.querySelector("#calculate").dispatchEvent(new win.Event("click", { bubbles: true }));
      const dayCells = [...win.document.querySelectorAll("#trips-body .trip-counted-days")].map((el) => el.textContent);
      check(
        "counted-day cells line up with the sorted rows after calculating",
        dayCells[0] === "60 дн." && dayCells[1] === "9 дн.",
        JSON.stringify(dayCells),
      );
      check("the table stays sorted after calculating", rowCountries(win).startsWith("Cyprus,Russia"), rowCountries(win));
      await sleep(SETTLE_MS);
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
    console.log(`\n${failures} sorting check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll sorting checks passed.");
  process.exit(0);
});
