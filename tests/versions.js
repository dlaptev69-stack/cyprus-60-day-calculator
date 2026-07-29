// Tests for the draft version history: /api/draft/versions and
// /api/draft/restore, plus the archiving that POST /api/draft performs.
//
// These are the safety net against the "trips disappeared" failure mode: an
// overwrite must always leave the previous payload restorable by the user who
// owns the workspace, and by nobody else.
//
// The persistence phase reloads server.js with NODE_ENV=production, because the
// production/DB_PATH self-check is evaluated once at module load. Each phase
// gets its own SQLite file so the two better-sqlite3 handles never share a
// database.
//
// Run with: npm test

const fs = require("fs");
const os = require("os");
const path = require("path");

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cyprus-60-versions-"));
process.env.API_RATE_LIMIT_DISABLED = "1";
delete process.env.RECOVERY_TOKEN;

const SERVER = require.resolve("../server.js");
const YEAR = 2026;
const VERSION_CAP = 100;

let failures = 0;
function check(name, cond, detail) {
  if (cond) {
    console.log(`  ok  ${name}`);
  } else {
    failures++;
    console.log(`  FAIL ${name}${detail ? " — " + detail : ""}`);
  }
}

function loadServer(dbName, { production } = {}) {
  delete require.cache[SERVER];
  process.env.DB_PATH = path.join(tmpDir, dbName);
  if (production) {
    process.env.NODE_ENV = "production";
  } else {
    delete process.env.NODE_ENV;
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

const trips = (...comments) =>
  comments.map((comment, i) => ({
    trip_country: i === 0 ? "Cyprus" : "Greece",
    date_arrival: `2026-0${i + 1}-01`,
    date_departure: `2026-0${i + 1}-10`,
    day_type: "stay",
    comment,
  }));

async function phaseHistory() {
  const { app } = loadServer("history.db");
  const { server, base } = await listen(app);

  const save = (code, payloadTrips, year = YEAR) =>
    fetch(`${base}/api/draft`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ access_code: code, payload: { tax_year: year, trips: payloadTrips } }),
    }).then((r) => r.json());

  const load = (code, year = YEAR) =>
    fetch(`${base}/api/draft?access_code=${encodeURIComponent(code)}&tax_year=${year}`).then((r) => r.json());

  const versionsRaw = (code, year = YEAR, extra = "") =>
    fetch(`${base}/api/draft/versions?access_code=${encodeURIComponent(code)}&tax_year=${year}${extra}`);

  const versions = (code, year = YEAR, extra = "") => versionsRaw(code, year, extra).then((r) => r.json());

  const restore = (body) =>
    fetch(`${base}/api/draft/restore`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

  try {
    // ---- a first save has nothing to archive ----
    console.log("\nArchiving on overwrite:");
    const CODE = "denis-version-history-2026";
    const first = await save(CODE, trips("зимовка в Лимассоле"));
    check("first save reports changed=true", first.ok === true && first.changed === true, JSON.stringify(first));
    check("first save archives nothing", first.archived_version_id === null, JSON.stringify(first));

    let list = await versions(CODE);
    check("history is empty for a never-overwritten draft", list.versions.length === 0, JSON.stringify(list.versions));
    check("history reports the current draft", list.current && list.current.trip_count === 1, JSON.stringify(list.current));
    check("history reports the retention cap", list.version_cap === VERSION_CAP, String(list.version_cap));

    // ---- overwriting archives the payload being replaced ----
    const second = await save(CODE, trips("зимовка в Лимассоле", "поездка в Афины"));
    check("overwrite reports the archived version id", Number.isInteger(second.archived_version_id), JSON.stringify(second));

    list = await versions(CODE);
    check("one version exists after one overwrite", list.versions.length === 1, JSON.stringify(list.versions));
    check("total_versions matches", list.total_versions === 1, String(list.total_versions));
    const archived = list.versions[0];
    check("archived version holds the PREVIOUS payload, not the new one", archived.trip_count === 1, JSON.stringify(archived));
    check("archived version is tagged with its source", archived.source === "overwrite", archived.source);
    check("archived version exposes when it was the live draft", typeof archived.saved_at === "string" && archived.saved_at.length > 0);
    check("archived version exposes when it was archived", typeof archived.archived_at === "string");
    check("current entry now describes the newer payload", list.current.trip_count === 2, JSON.stringify(list.current));
    check("current entry is marked as current", list.current.current === true);

    // ---- the "blank form clobbers everything" scenario is reversible ----
    const blanked = await save(CODE, []);
    check("a blank save is accepted", blanked.ok === true);
    check("the blank save archived the two-trip payload", Number.isInteger(blanked.archived_version_id));
    const afterBlank = await load(CODE);
    check("draft really is blank now", afterBlank.payload.trips.length === 0, JSON.stringify(afterBlank.payload.trips));
    list = await versions(CODE);
    check("both earlier states are still restorable", list.versions.length === 2, JSON.stringify(list.versions.map((v) => v.trip_count)));

    // ---- summaries ----
    console.log("\nVersion summaries:");
    const twoTrip = list.versions.find((v) => v.trip_count === 2);
    check("summary lists sorted unique countries", twoTrip.countries.join(",") === "Cyprus,Greece", twoTrip.countries.join(","));
    check(
      "summary reports the overall date range",
      twoTrip.earliest_date === "2026-01-01" && twoTrip.latest_date === "2026-02-10",
      `${twoTrip.earliest_date}..${twoTrip.latest_date}`,
    );
    check(
      "summary previews the comments",
      twoTrip.comment_count === 2 && twoTrip.comments_preview.join("|") === "зимовка в Лимассоле|поездка в Афины",
      JSON.stringify(twoTrip.comments_preview),
    );
    const listText = await versionsRaw(CODE).then((r) => r.text());
    check("version list never returns stored payloads", !/"payload"/.test(listText));
    check("version list never returns an access_code_hash", !/access_code_hash/.test(listText));
    check("version list never echoes the access code", !listText.includes(CODE));

    // ---- dedupe ----
    console.log("\nDeduplication:");
    const before = (await versions(CODE)).total_versions;
    const repeat = await save(CODE, []);
    check("re-saving an identical payload reports changed=false", repeat.changed === false, JSON.stringify(repeat));
    check("re-saving an identical payload archives nothing", repeat.archived_version_id === null, JSON.stringify(repeat));
    check("identical re-save does not grow the history", (await versions(CODE)).total_versions === before);
    const repeatedAgain = await save(CODE, []);
    check("a third identical save still archives nothing", repeatedAgain.archived_version_id === null);

    // ---- restore ----
    console.log("\nRestore:");
    list = await versions(CODE);
    const target = list.versions.find((v) => v.trip_count === 2);
    const restored = await restore({ access_code: CODE, tax_year: YEAR, version_id: target.version_id }).then((r) => r.json());
    check("restore reports ok", restored.ok === true && restored.restored === true, JSON.stringify(restored));
    check("restore returns the payload so the UI can hydrate", restored.payload.trips.length === 2, JSON.stringify(restored.payload));
    check("restore reports the version's original save time", restored.restored_from === target.saved_at);
    const afterRestore = await load(CODE);
    check("the draft now serves the restored trips", afterRestore.payload.trips.length === 2, JSON.stringify(afterRestore.payload.trips));
    check(
      "restored payload matches the archived one exactly",
      JSON.stringify(afterRestore.payload.trips) === JSON.stringify(trips("зимовка в Лимассоле", "поездка в Афины")),
      JSON.stringify(afterRestore.payload.trips),
    );

    // ---- a restore is itself undoable ----
    check("restore archived the draft it replaced", Number.isInteger(restored.archived_version_id));
    list = await versions(CODE);
    const undo = list.versions.find((v) => v.version_id === restored.archived_version_id);
    check("the replaced draft is in the history", Boolean(undo), JSON.stringify(list.versions));
    check("the replaced draft is tagged source=restore", undo && undo.source === "restore", undo && undo.source);
    check("the replaced draft was the blank one", undo && undo.trip_count === 0, undo && String(undo.trip_count));
    const undone = await restore({ access_code: CODE, tax_year: YEAR, version_id: undo.version_id }).then((r) => r.json());
    check("restoring the pre-restore state works too", undone.ok === true && undone.payload.trips.length === 0, JSON.stringify(undone.payload));

    // ---- validation ----
    console.log("\nValidation:");
    check("versions rejects a short access_code", (await versionsRaw("short")).status === 400);
    check("versions rejects a bad tax_year", (await versionsRaw(CODE, "abc")).status === 400);
    check(
      "restore rejects a short access_code",
      (await restore({ access_code: "short", tax_year: YEAR, version_id: 1 })).status === 400,
    );
    check(
      "restore rejects a bad tax_year",
      (await restore({ access_code: CODE, tax_year: "abc", version_id: 1 })).status === 400,
    );
    for (const bad of [undefined, null, "abc", 0, -3, 1.5, "1; DROP TABLE drafts"]) {
      const res = await restore({ access_code: CODE, tax_year: YEAR, version_id: bad });
      check(`restore rejects version_id=${JSON.stringify(bad)}`, res.status === 400, `status ${res.status}`);
    }
    check(
      "restore 404s on an unknown version_id",
      (await restore({ access_code: CODE, tax_year: YEAR, version_id: 999999 })).status === 404,
    );

    // ---- workspace isolation ----
    console.log("\nWorkspace isolation:");
    const OTHER = "someone-else-workspace-2026";
    await save(OTHER, trips("чужие данные"));
    await save(OTHER, trips("чужие данные", "и ещё"));
    const otherList = await versions(OTHER);
    check("the other workspace sees only its own version", otherList.total_versions === 1, String(otherList.total_versions));
    check(
      "the other workspace's version ids do not overlap ours",
      !otherList.versions.some((v) => list.versions.some((mine) => mine.version_id === v.version_id)),
    );

    const stolen = await restore({ access_code: OTHER, tax_year: YEAR, version_id: target.version_id });
    check("restoring another workspace's version_id is 404", stolen.status === 404, `status ${stolen.status}`);
    const otherAfter = await load(OTHER);
    check(
      "the blocked restore left the other workspace's draft untouched",
      otherAfter.payload.trips.length === 2 && otherAfter.payload.trips[0].comment === "чужие данные",
      JSON.stringify(otherAfter.payload.trips),
    );

    // ---- versions are scoped per tax year, not just per workspace ----
    await save(CODE, trips("2025 год"), 2025);
    await save(CODE, trips("2025 год", "правка"), 2025);
    const y2025 = await versions(CODE, 2025);
    check("each tax year keeps its own history", y2025.total_versions === 1, String(y2025.total_versions));
    const crossYear = await restore({ access_code: CODE, tax_year: 2025, version_id: target.version_id });
    check("a version_id from another tax year is 404", crossYear.status === 404, `status ${crossYear.status}`);

    // ---- retention cap ----
    console.log("\nRetention cap:");
    const CAP_CODE = "cap-behaviour-workspace-2026";
    // Saves 1..105 archive payloads 1..104; the cap keeps the newest 100, so
    // payloads 1..4 must be gone and "edit 5" is the oldest survivor.
    for (let i = 1; i <= VERSION_CAP + 5; i++) {
      await save(CAP_CODE, trips(`edit ${i}`));
    }
    const capped = await versions(CAP_CODE, YEAR, `&limit=${VERSION_CAP}`);
    check(`history is capped at ${VERSION_CAP} versions`, capped.total_versions === VERSION_CAP, String(capped.total_versions));
    check(
      "the newest archived version is the most recent overwrite",
      capped.versions[0].comments_preview[0] === `edit ${VERSION_CAP + 4}`,
      capped.versions[0].comments_preview[0],
    );
    check(
      "the oldest versions were pruned, not the newest",
      capped.versions[capped.versions.length - 1].comments_preview[0] === "edit 5",
      capped.versions[capped.versions.length - 1].comments_preview[0],
    );
    const defaultPage = await versions(CAP_CODE);
    check("the list defaults to a single page of 20", defaultPage.versions.length === 20, String(defaultPage.versions.length));
    check("but still reports the true total", defaultPage.total_versions === VERSION_CAP, String(defaultPage.total_versions));
    const overLimit = await versions(CAP_CODE, YEAR, "&limit=9999");
    check("limit cannot exceed the cap", overLimit.versions.length === VERSION_CAP, String(overLimit.versions.length));

    // ---- deleting a draft takes its history with it ----
    console.log("\nDeleting a workspace:");
    const del = await fetch(
      `${base}/api/draft?access_code=${encodeURIComponent(CAP_CODE)}&tax_year=${YEAR}`,
      { method: "DELETE" },
    ).then((r) => r.json());
    check("delete reports the draft row it removed", del.deleted === 1, JSON.stringify(del));
    check("delete reports the versions it purged", del.deleted_versions === VERSION_CAP, JSON.stringify(del));
    const afterDelete = await versions(CAP_CODE);
    check("no history survives the delete", afterDelete.total_versions === 0 && afterDelete.current === null, JSON.stringify(afterDelete));

    // ---- health persistence reporting (development) ----
    console.log("\nPersistence visibility (development):");
    const health = await fetch(`${base}/api/health`).then((r) => r.json());
    check("health still reports ok", health.ok === true);
    check("health reports a persistence block", Boolean(health.persistence), JSON.stringify(health));
    check("health reports the db basename only", health.persistence.db_file === "history.db", health.persistence.db_file);
    check(
      "health does not leak the absolute db path",
      !JSON.stringify(health).includes(tmpDir),
      JSON.stringify(health.persistence),
    );
    check("health reports the expected production path", health.persistence.expected_production_db_path === "/data/data.db");
    check("health reports whether DB_PATH is set", health.persistence.db_path_env_set === true);
    check("health classifies a temp-dir database as non-durable", health.persistence.durable === false, health.persistence.path_class);
    check("health reports the version cap", health.persistence.draft_version_cap === VERSION_CAP);
    check(
      "no production warning outside production",
      health.persistence.production === false &&
        !health.persistence.warnings.some((w) => /DB_PATH/.test(w)),
      JSON.stringify(health.persistence.warnings),
    );
  } finally {
    await close(server);
  }
}

async function phaseProductionPersistence() {
  console.log("\nPersistence visibility (NODE_ENV=production, DB_PATH off /data):");
  const { app } = loadServer("prod.db", { production: true });
  const { server, base } = await listen(app);
  try {
    const health = await fetch(`${base}/api/health`).then((r) => r.json());
    check("health flags the deployment as production", health.persistence.production === true);
    check("health flags the database as not durable", health.persistence.durable === false);
    check(
      "health warns that DB_PATH is not under /data",
      health.persistence.warnings.filter((w) => /\/data\/data\.db/.test(w)).length === 1,
      JSON.stringify(health.persistence.warnings),
    );
    check(
      "the warning does not leak the absolute path",
      !JSON.stringify(health).includes(tmpDir),
      JSON.stringify(health.persistence.warnings),
    );
  } finally {
    await close(server);
    delete process.env.NODE_ENV;
  }
}

(async () => {
  try {
    await phaseHistory();
    await phaseProductionPersistence();
  } catch (err) {
    failures++;
    console.log(`  FAIL exception: ${err.stack || err.message}`);
  }

  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch (_) {
    // best effort
  }
  if (failures) {
    console.log(`\n${failures} version-history check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll version-history checks passed.");
  process.exit(0);
})();
