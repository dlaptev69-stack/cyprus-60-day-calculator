// The 183-day rule is an independent path to Cyprus tax residency, and the
// non-dom assessment (SDC Law) follows the residency result.
const { calculateCyprusResidency } = require("../public/calc.js");

let failures = 0;
function check(name, cond, detail) {
  if (cond) console.log(`  ok  ${name}`);
  else { failures++; console.log(`  FAIL ${name}${detail ? ": " + detail : ""}`); }
}
const T = (c, a, d) => ({ trip_country: c, date_arrival: a, date_departure: d, day_type: "stay" });
function input(extra, trips) {
  return Object.assign({
    tax_year: 2026,
    has_cyprus_home: "yes",
    has_cyprus_business_or_employment_or_directorship: "yes",
    possible_tax_resident_elsewhere: "no",
    trips,
  }, extra);
}
const over183 = [T("Cyprus", "2026-01-01", "2026-08-01"), T("Russia", "2026-08-01", "2026-12-31")];
const rule60 = [T("Cyprus", "2026-01-01", "2026-03-15"), T("Russia", "2026-03-15", "2026-06-01")];
const fail60 = [T("Cyprus", "2026-01-01", "2026-02-01"), T("Russia", "2026-02-01", "2026-12-31")];

// 183-day rule
let r = calculateCyprusResidency(input({
  has_cyprus_home: "no",
  has_cyprus_business_or_employment_or_directorship: "no",
  possible_tax_resident_elsewhere: "yes",
}, over183));
check("183: qualifies without home, business or other-country test", r.preliminary_status === "likely qualifies", r.preliminary_status);
check("183: residency rule is 183", r.residency_rule === "183", r.residency_rule);
check("183: no home or business warnings", !r.warnings.some((w) => /home|business/.test(w.type)), JSON.stringify(r.warnings));
check("183: dual residency gets the 183 tie-breaker note", r.warnings.some((w) => w.type === "dual_residency_tie_breaker_183"));

r = calculateCyprusResidency(input({ tax_year: 2025, possible_tax_resident_elsewhere: "yes" },
  [T("Cyprus", "2025-01-01", "2025-08-01"), T("Russia", "2025-08-01", "2025-12-31")]));
check("183 in 2025: other residency does not block either", r.preliminary_status === "likely qualifies" && r.residency_rule === "183", r.preliminary_status);

r = calculateCyprusResidency(input({}, rule60));
check("60: residency rule is 60", r.preliminary_status === "likely qualifies" && r.residency_rule === "60", `${r.preliminary_status} ${r.residency_rule}`);

r = calculateCyprusResidency(input({}, fail60));
check("fail: no residency rule", r.preliminary_status === "likely does not qualify" && r.residency_rule === null, `${r.preliminary_status} ${r.residency_rule}`);

r = calculateCyprusResidency(input({ has_cyprus_home: "unknown" }, rule60));
check("review: 60-day path with missing home stays in review", r.preliminary_status === "needs tax advisor review" && r.residency_rule === null, r.preliminary_status);

// Non-dom
const nd = (extra, trips) => calculateCyprusResidency(input(extra, trips)).non_dom;
check("non-dom: no data", nd({}, rule60).status === "needs_data");
check("non-dom: years missing", nd({ cyprus_domicile_of_origin: "no" }, rule60).status === "needs_data");
check("non-dom: likely when resident", nd({ cyprus_domicile_of_origin: "no", prior_cyprus_resident_years: 0 }, rule60).status === "likely_non_dom");
check("non-dom: string years accepted", nd({ cyprus_domicile_of_origin: "no", prior_cyprus_resident_years: "16" }, over183).status === "likely_non_dom");
check("non-dom: not resident this year", nd({ cyprus_domicile_of_origin: "no", prior_cyprus_resident_years: 0 }, fail60).status === "not_resident");
check("non-dom: depends on residency", nd({ cyprus_domicile_of_origin: "no", prior_cyprus_resident_years: 0, has_cyprus_home: "unknown" }, rule60).status === "depends_on_residency");
let x = nd({ cyprus_domicile_of_origin: "no", prior_cyprus_resident_years: 17 }, rule60);
check("non-dom: 17 of 20 means deemed domiciled", x.status === "deemed_domiciled" && x.deemed_domiciled === true);
check("non-dom: extension possible for non-Cyprus origin", x.extension_possible === true);
x = nd({ cyprus_domicile_of_origin: "unknown", prior_cyprus_resident_years: 18 }, rule60);
check("non-dom: extension not confirmed when origin unknown", x.status === "deemed_domiciled" && x.extension_possible === false);
x = nd({ cyprus_domicile_of_origin: "yes", prior_cyprus_resident_years: 0 }, rule60);
check("non-dom: Cyprus origin goes to review", x.status === "cyprus_origin_review" && x.extension_possible === false);
check("non-dom: out of range years ignored", nd({ cyprus_domicile_of_origin: "no", prior_cyprus_resident_years: 25 }, rule60).status === "needs_data");

if (failures) { console.log(`\n${failures} non-dom check(s) failed`); process.exit(1); }
console.log("\nnon-dom and 183-day checks passed");
