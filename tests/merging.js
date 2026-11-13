// Neighbouring rows of the same country are joined automatically, but only
// when the join leaves the calculation unchanged. Also checks that the server
// stores the joined list.
const fs = require("fs");
const os = require("os");
const path = require("path");

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cyprus-60-merge-"));
process.env.DB_PATH = path.join(tmpDir, "data.db");
process.env.PORT = "0";
process.env.API_RATE_LIMIT_DISABLED = "1";

const { calculateCyprusResidency, mergeAdjacentTrips } = require("../public/calc.js");
const { app } = require("../server.js");

let failures = 0;
function check(name, cond, detail) {
  if (cond) console.log(`  ok  ${name}`);
  else { failures++; console.log(`  FAIL ${name}${detail ? ": " + detail : ""}`); }
}

const settings = {
  arrival_day_counts_for_cyprus: true,
  departure_day_counts_for_cyprus: false,
  same_day_arrival_departure_counts_for_cyprus: true,
  same_day_departure_return_counts_for_cyprus: false,
  transit_day_counts_for_cyprus: false,
  arrival_day_counts_other_countries: true,
  departure_day_counts_other_countries: false,
};
const opts = { tax_year: 2026, settings };
const T = (c, a, d, comment = "", day_type = "stay") => ({ trip_country: c, date_arrival: a, date_departure: d, day_type, comment });
const days = (trips) => {
  const r = calculateCyprusResidency({
    tax_year: 2026, has_cyprus_home: "yes", has_cyprus_business_or_employment_or_directorship: "yes",
    possible_tax_resident_elsewhere: "no", settings, trips,
  });
  return JSON.stringify(r.country_day_breakdown.map((e) => [e.country, e.days]));
};

// 1. Touching rows of the same country are joined, counts unchanged.
let input = [T("Russia", "2026-10-04", "2026-10-05"), T("Russia", "2026-10-05", "2026-10-27", "TripIt"), T("Kazakhstan", "2026-10-27", "2026-10-30")];
let out = mergeAdjacentTrips(input, opts);
check("touching Russia rows are joined", out.length === 2 && out[0].date_arrival === "2026-10-04" && out[0].date_departure === "2026-10-27", JSON.stringify(out));
check("joined comment is kept", out[0].comment === "TripIt", out[0].comment);
check("day counts unchanged after join", days(input) === days(out), `${days(input)} vs ${days(out)}`);
check("input is not mutated", input.length === 3 && input[0].date_departure === "2026-10-05");

// 2. A gap between rows keeps them apart (joining would count the gap).
out = mergeAdjacentTrips([T("Russia", "2026-04-01", "2026-04-05"), T("Russia", "2026-04-07", "2026-04-10")], opts);
check("rows with a gap stay separate", out.length === 2);

// 3. Same-day departure and return to Cyprus is a separate case: not joined.
input = [T("Cyprus", "2026-03-01", "2026-03-10"), T("Cyprus", "2026-03-10", "2026-03-20")];
out = mergeAdjacentTrips(input, opts);
check("Cyprus same-day departure and return stays two rows", out.length === 2, JSON.stringify(out));

// 4. Different day types or countries are not joined; spelling aliases are.
out = mergeAdjacentTrips([T("Russia", "2026-05-01", "2026-05-03"), T("Russia", "2026-05-03", "2026-05-04", "", "transit")], opts);
check("different day types stay separate", out.length === 2);
out = mergeAdjacentTrips([T("France", "2026-01-09", "2026-01-11"), T("Germany", "2026-01-11", "2026-01-18")], opts);
check("different countries stay separate", out.length === 2);

// 5. Overlapping rows of one country become one row covering both.
input = [T("Italy", "2026-02-06", "2026-02-15", "a"), T("Italy", "2026-02-10", "2026-02-23", "b")];
out = mergeAdjacentTrips(input, opts);
check("overlapping rows are joined", out.length === 1 && out[0].date_departure === "2026-02-23" && out[0].comment === "a; b", JSON.stringify(out));
check("overlap join keeps counts", days(input) === days(out));

// 6. Unsorted input is sorted first; rows without dates stay at the end.
out = mergeAdjacentTrips([T("Russia", "2026-10-05", "2026-10-27"), T("", "", ""), T("Russia", "2026-10-04", "2026-10-05")], opts);
check("unsorted touching rows are joined and blank row stays last", out.length === 2 && out[0].date_departure === "2026-10-27" && out[1].trip_country === "", JSON.stringify(out));

// 7. A join that would make the comment too long is skipped.
out = mergeAdjacentTrips([T("Russia", "2026-10-04", "2026-10-05", "x".repeat(120)), T("Russia", "2026-10-05", "2026-10-27", "y".repeat(120))], opts);
check("over-long comment join is skipped", out.length === 2);

const server = app.listen(0, "127.0.0.1", async () => {
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const payload = {
      tax_year: 2026, has_cyprus_home: "yes", has_cyprus_business_or_employment_or_directorship: "yes",
      possible_tax_resident_elsewhere: "no", settings,
      trips: [T("Russia", "2026-10-04", "2026-10-05"), T("Russia", "2026-10-05", "2026-10-27", "TripIt"), T("Kazakhstan", "2026-10-27", "2026-10-30")],
    };
    const saved = await fetch(`${base}/api/default-draft`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ payload }),
    }).then((r) => r.json());
    check("server accepts the save", saved.ok === true, JSON.stringify(saved));
    const got = await fetch(`${base}/api/default-draft?tax_year=2026`).then((r) => r.json());
    const trips = got.payload.trips;
    check("server stores the joined list", trips.length === 2 && trips[0].date_departure === "2026-10-27", JSON.stringify(trips));
  } catch (e) {
    failures++;
    console.log("  FAIL server check threw: " + e.message);
  } finally {
    server.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    if (failures) { console.log(`\n${failures} merging check(s) failed`); process.exit(1); }
    console.log("\nAll merging checks passed.");
    process.exit(0);
  }
});
