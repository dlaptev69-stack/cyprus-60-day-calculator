// The 2026 Cyprus tax reform (Law 244(I)/2025) removed the condition "not tax
// resident in any other state" from the 60-day rule. The 183-day ceiling for
// any other single state still applies. Earlier tax years keep the old rule.
const { calculateCyprusResidency } = require("../public/calc.js");

let failures = 0;
function check(name, cond, detail) {
  if (cond) console.log(`  ok  ${name}`);
  else { failures++; console.log(`  FAIL ${name}${detail ? ": " + detail : ""}`); }
}

function input(year, elsewhere, trips) {
  return {
    tax_year: year,
    has_cyprus_home: "yes",
    has_cyprus_business_or_employment_or_directorship: "yes",
    possible_tax_resident_elsewhere: elsewhere,
    trips,
  };
}
const okTrips = (y) => [
  { trip_country: "Cyprus", date_arrival: `${y}-01-01`, date_departure: `${y}-03-15`, day_type: "stay" },
  { trip_country: "Russia", date_arrival: `${y}-03-15`, date_departure: `${y}-06-01`, day_type: "stay" },
];

let r = calculateCyprusResidency(input(2026, "yes", okTrips(2026)));
check("2026: resident elsewhere does not block the 60-day rule", r.preliminary_status === "likely qualifies", r.preliminary_status);
check("2026: dual residency is flagged as a tie-breaker note", r.warnings.some((w) => w.type === "dual_residency_tie_breaker"));
check("2026: old blocking warning is not raised", !r.warnings.some((w) => w.type === "possible_tax_residency_elsewhere"));
check("2026: condition flag is false", r.tax_resident_elsewhere_is_condition === false);

r = calculateCyprusResidency(input(2025, "yes", okTrips(2025)));
check("2025: resident elsewhere still needs review", r.preliminary_status === "needs tax advisor review", r.preliminary_status);
check("2025: old warning kept", r.warnings.some((w) => w.type === "possible_tax_residency_elsewhere"));
check("2025: condition flag is true", r.tax_resident_elsewhere_is_condition === true);

r = calculateCyprusResidency(input(2026, "no", [
  { trip_country: "Cyprus", date_arrival: "2026-01-01", date_departure: "2026-03-15", day_type: "stay" },
  { trip_country: "Russia", date_arrival: "2026-03-15", date_departure: "2026-12-31", day_type: "stay" },
]));
check("2026: more than 183 days in another state still fails", r.preliminary_status === "likely does not qualify", r.preliminary_status);

if (failures) { console.log(`\n${failures} residency rule check(s) failed`); process.exit(1); }
console.log("\nresidency rule checks passed");
