// API tests for the shared default profile: /api/default-draft/*, the optional
// APP_ACCESS_PASSWORD gate, and the recovery migration onto the default
// profile.
//
// The contract under test is that a caller who sends no access code still gets
// a stable, shared, versioned draft — and that the code backing it never
// appears in a response.
//
// Each phase reloads server.js with its own env and its own SQLite file,
// because DEFAULT_WORKSPACE_ACCESS_CODE, APP_ACCESS_PASSWORD and RECOVERY_TOKEN
// are all read once at module load.
//
// Run with: npm test

const fs = require("fs");
const os = require("os");
const path = require("path");

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cyprus-60-default-"));
process.env.API_RATE_LIMIT_DISABLED = "1";

const SERVER = require.resolve("../server.js");
const YEAR = 2026;
const DEFAULT_CODE = "shared-default-profile-code-2026";
// Must match BUILTIN_DEFAULT_WORKSPACE_ACCESS_CODE in server.js.
const EXPECTED_FALLBACK_CODE = "nadya-cyprus60-default-workspace-v1";
const RECOVERY_TOKEN = "recovery-token-for-tests-0123456789";

let failures = 0;
function check(name, cond, detail) {
  if (cond) {
    console.log(`  ok  ${name}`);
  } else {
    failures++;
    console.log(`  FAIL ${name}${detail ? " — " + detail : ""}`);
  }
}

function loadServer(dbName, env = {}) {
  delete require.cache[SERVER];
  process.env.DB_PATH = path.join(tmpDir, dbName);
  for (const key of ["DEFAULT_WORKSPACE_ACCESS_CODE", "APP_ACCESS_PASSWORD", "RECOVERY_TOKEN"]) {
    if (env[key] === undefined) delete process.env[key];
    else process.env[key] = env[key];
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

const trips = (...countries) =>
  countries.map((country, i) => ({
    trip_country: country,
    date_arrival: `2026-0${i + 1}-01`,
    date_departure: `2026-0${i + 1}-10`,
    day_type: "stay",
    comment: `note ${country}`,
  }));

const json = (res) => res.json();

// ---- Phase 1: the shared profile behaves like one draft for everybody -------

async function phaseShared() {
  console.log("\nShared default profile (no access code from the client):");
  const { app } = loadServer("shared.db", { DEFAULT_WORKSPACE_ACCESS_CODE: DEFAULT_CODE });
  const { server, base } = await listen(app);

  const load = (year = YEAR) => fetch(`${base}/api/default-draft?tax_year=${year}`).then(json);
  const save = (payloadTrips, year = YEAR) =>
    fetch(`${base}/api/default-draft`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ payload: { tax_year: year, trips: payloadTrips } }),
    }).then(json);

  try {
    const empty = await load();
    check("an unseeded default profile reports found=false", empty.ok && empty.found === false);

    const saved = await save(trips("Cyprus", "Greece"));
    check("saving without an access code succeeds", saved.ok === true, JSON.stringify(saved));
    check("the save echoes the tax_year it used", saved.tax_year === YEAR);

    // A second, entirely independent client — no cookies, no headers, nothing
    // carried over — must see the same list.
    const seen = await load();
    check("a second client with no cookie sees the same list", seen.found === true && seen.payload.trips.length === 2);
    check(
      "the list contents match what the first client saved",
      seen.payload.trips.map((t) => t.trip_country).join(",") === "Cyprus,Greece",
      JSON.stringify(seen.payload.trips.map((t) => t.trip_country)),
    );

    check(
      "no response field exposes the access code",
      !JSON.stringify(seen).includes(DEFAULT_CODE) && !JSON.stringify(saved).includes(DEFAULT_CODE),
    );
    check(
      "no response field exposes an access_code_hash",
      !/access_code/.test(JSON.stringify(seen)) && !/access_code/.test(JSON.stringify(saved)),
    );

    // The default profile is per tax_year, like the legacy one.
    await save(trips("Portugal"), 2025);
    const y2025 = await load(2025);
    const y2026 = await load(2026);
    check("each tax_year keeps its own default list", y2025.payload.trips.length === 1 && y2026.payload.trips.length === 2);

    const badYear = await fetch(`${base}/api/default-draft?tax_year=nope`);
    check("an invalid tax_year is rejected", badYear.status === 400);

    const badPayload = await fetch(`${base}/api/default-draft`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ payload: { tax_year: YEAR, trips: "not an array" } }),
    });
    check("an invalid payload is rejected", badPayload.status === 400);

    const health = await fetch(`${base}/api/health`).then(json);
    check("health does not leak the default access code", !JSON.stringify(health).includes(DEFAULT_CODE));
    check("health reports the default profile is configured", health.persistence.default_workspace_env_set === true);
    check("health reports no password is required", health.persistence.password_required === false);
    check(
      "health warns that the app is open to anyone with the URL",
      health.persistence.warnings.some((w) => /APP_ACCESS_PASSWORD/.test(w)),
      JSON.stringify(health.persistence.warnings),
    );
  } finally {
    await close(server);
  }
}

// ---- Phase 2: built-in fallback ---------------------------------------------

async function phaseFallback() {
  console.log("\nBuilt-in fallback when DEFAULT_WORKSPACE_ACCESS_CODE is unset:");
  const { app } = loadServer("fallback.db", {});
  const { server, base } = await listen(app);
  try {
    const saved = await fetch(`${base}/api/default-draft`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ payload: { tax_year: YEAR, trips: trips("Cyprus") } }),
    }).then(json);
    check("the app still works with no env configured", saved.ok === true);

    const seen = await fetch(`${base}/api/default-draft?tax_year=${YEAR}`).then(json);
    check("the fallback profile round-trips", seen.found === true && seen.payload.trips.length === 1);

    const health = await fetch(`${base}/api/health`).then(json);
    check("health reports the env is not set", health.persistence.default_workspace_env_set === false);
    check(
      "health warns that the built-in identifier is in use",
      health.persistence.warnings.some((w) => /DEFAULT_WORKSPACE_ACCESS_CODE/.test(w)),
      JSON.stringify(health.persistence.warnings),
    );

    // Two editions of this app pointed at one database must not collide on a
    // single profile, so the unconfigured fallback has to be edition-specific.
    // Writing through the legacy endpoint under the expected code has to land on
    // the very draft the default endpoint reads.
    await fetch(`${base}/api/draft`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        access_code: EXPECTED_FALLBACK_CODE,
        payload: { tax_year: YEAR, trips: trips("Portugal", "Malta") },
      }),
    }).then(json);
    const viaFallback = await fetch(`${base}/api/default-draft?tax_year=${YEAR}`).then(json);
    check(
      "the fallback profile is namespaced to this edition",
      viaFallback.payload.trips.map((t) => t.trip_country).join(",") === "Portugal,Malta",
      JSON.stringify(viaFallback.payload.trips.map((t) => t.trip_country)),
    );
  } finally {
    await close(server);
  }
}

// ---- Phase 3: version archive through the default endpoints -----------------

async function phaseVersions() {
  console.log("\nArchive through the default-profile endpoints:");
  const { app } = loadServer("versions.db", { DEFAULT_WORKSPACE_ACCESS_CODE: DEFAULT_CODE });
  const { server, base } = await listen(app);

  const save = (payloadTrips) =>
    fetch(`${base}/api/default-draft`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ payload: { tax_year: YEAR, trips: payloadTrips } }),
    }).then(json);
  const versions = () => fetch(`${base}/api/default-draft/versions?tax_year=${YEAR}`).then(json);
  const restore = (versionId) =>
    fetch(`${base}/api/default-draft/restore`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tax_year: YEAR, version_id: versionId }),
    }).then(json);

  try {
    const first = await save(trips("Cyprus", "Greece"));
    check("the very first save archives nothing", first.archived_version_id === null, JSON.stringify(first));
    check("an empty archive lists no versions", (await versions()).total_versions === 0);

    const overwrite = await save([]); // the accident
    check("overwriting with a different payload creates a version", Number.isInteger(overwrite.archived_version_id));

    const afterOverwrite = await versions();
    check("the archive lists the overwritten payload", afterOverwrite.total_versions === 1);
    check(
      "the archived entry summarises the trips it holds",
      afterOverwrite.versions[0].trip_count === 2 &&
        afterOverwrite.versions[0].countries.join(",") === "Cyprus,Greece",
      JSON.stringify(afterOverwrite.versions[0]),
    );
    check(
      "the archive describes the current (blank) list too",
      afterOverwrite.current && afterOverwrite.current.trip_count === 0,
      JSON.stringify(afterOverwrite.current),
    );
    // Summaries carry payload_bytes (a size) but never the payload itself.
    check(
      "the archive never returns stored payloads or a hash",
      !/"payload"/.test(JSON.stringify(afterOverwrite)) &&
        !/access_code/.test(JSON.stringify(afterOverwrite)),
      JSON.stringify(afterOverwrite).slice(0, 200),
    );

    // Dedupe: re-saving the identical payload must not grow the archive.
    await save([]);
    await save([]);
    check("identical re-saves are deduplicated", (await versions()).total_versions === 1);

    const restored = await restore(afterOverwrite.versions[0].version_id);
    check("restoring returns the recovered payload", restored.ok && restored.payload.trips.length === 2);
    const now = await fetch(`${base}/api/default-draft?tax_year=${YEAR}`).then(json);
    check("the restored list becomes the current one", now.payload.trips.length === 2);
    check(
      "the restore is itself undoable (the blank list was archived)",
      (await versions()).versions.some((v) => v.trip_count === 0 && v.source === "restore"),
    );

    const missing = await fetch(`${base}/api/default-draft/restore`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tax_year: YEAR, version_id: 999999 }),
    });
    check("restoring an unknown version 404s", missing.status === 404);

    const badId = await fetch(`${base}/api/default-draft/restore`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tax_year: YEAR, version_id: "abc" }),
    });
    check("a non-numeric version_id is rejected", badId.status === 400);
  } finally {
    await close(server);
  }
}

// ---- Phase 4: optional password gate ----------------------------------------

async function phasePassword() {
  console.log("\nOptional APP_ACCESS_PASSWORD gate:");
  const PASSWORD = "denis-secret-passphrase";
  const { app } = loadServer("password.db", {
    DEFAULT_WORKSPACE_ACCESS_CODE: DEFAULT_CODE,
    APP_ACCESS_PASSWORD: PASSWORD,
  });
  const { server, base } = await listen(app);

  try {
    const status = await fetch(`${base}/api/auth/status`).then(json);
    check("status reports that a password is required", status.password_required === true);
    check("status reports an anonymous caller as unauthenticated", status.authenticated === false);

    for (const [name, res] of [
      ["GET /api/default-draft", await fetch(`${base}/api/default-draft?tax_year=${YEAR}`)],
      ["GET /api/default-draft/versions", await fetch(`${base}/api/default-draft/versions?tax_year=${YEAR}`)],
      [
        "POST /api/default-draft",
        await fetch(`${base}/api/default-draft`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ payload: { tax_year: YEAR, trips: trips("Cyprus") } }),
        }),
      ],
      [
        "POST /api/default-draft/restore",
        await fetch(`${base}/api/default-draft/restore`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ tax_year: YEAR, version_id: 1 }),
        }),
      ],
    ]) {
      check(`${name} is refused without a session`, res.status === 401);
    }

    const wrong = await fetch(`${base}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: "not-the-password" }),
    });
    check("logging in with a wrong password is refused", wrong.status === 401);

    const loginRes = await fetch(`${base}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: PASSWORD }),
    });
    const login = await loginRes.json();
    check("logging in with the right password succeeds", loginRes.status === 200 && login.ok === true);

    const setCookie = loginRes.headers.get("set-cookie") || "";
    check("the session cookie is httpOnly", /HttpOnly/i.test(setCookie), setCookie);
    check("the session cookie is SameSite=Lax", /SameSite=Lax/i.test(setCookie), setCookie);
    check("the session cookie does not contain the password", !setCookie.includes(PASSWORD), setCookie);

    const cookie = setCookie.split(";")[0];
    const withCookie = (url, init = {}) =>
      fetch(url, { ...init, headers: { ...(init.headers || {}), Cookie: cookie } });

    const saved = await withCookie(`${base}/api/default-draft`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ payload: { tax_year: YEAR, trips: trips("Cyprus") } }),
    }).then(json);
    check("a logged-in client can save", saved.ok === true, JSON.stringify(saved));

    const loaded = await withCookie(`${base}/api/default-draft?tax_year=${YEAR}`).then(json);
    check("a logged-in client can load", loaded.found === true && loaded.payload.trips.length === 1);

    const listed = await withCookie(`${base}/api/default-draft/versions?tax_year=${YEAR}`).then(json);
    check("a logged-in client can list the archive", listed.ok === true);

    // The bearer form of the same token lets curl drive the API.
    const viaBearer = await fetch(`${base}/api/default-draft?tax_year=${YEAR}`, {
      headers: { Authorization: `Bearer ${login.token}` },
    }).then(json);
    check("the session token also works as a bearer header", viaBearer.found === true);

    const forged = await fetch(`${base}/api/default-draft?tax_year=${YEAR}`, {
      headers: { Cookie: "cyprus60_session=v1.9999999999999.deadbeef" },
    });
    check("a forged session cookie is refused", forged.status === 401);

    const statusIn = await withCookie(`${base}/api/auth/status`).then(json);
    check("status reports a logged-in caller as authenticated", statusIn.authenticated === true);

    const logout = await withCookie(`${base}/api/auth/logout`, { method: "POST" });
    check("logout clears the session cookie", /cyprus60_session=;/.test(logout.headers.get("set-cookie") || ""));

    // Legacy per-workspace access is deliberately unaffected: it carries its
    // own credential in the access code.
    const legacy = await fetch(`${base}/api/draft?access_code=some-other-workspace-key&tax_year=${YEAR}`);
    check("the password gate does not break legacy workspace access", legacy.status === 200);
  } finally {
    await close(server);
  }
}

// ---- Phase 5: recovery migration onto the default profile -------------------

async function phaseCopyToDefault() {
  console.log("\nRecovery copy onto the default profile:");
  const { app } = loadServer("copy.db", {
    DEFAULT_WORKSPACE_ACCESS_CODE: DEFAULT_CODE,
    RECOVERY_TOKEN,
  });
  const { server, base } = await listen(app);

  const RECOVERED_CODE = "denis-restored-Q9owkAzM6J2VSILxlJNQjjjckQdAZvd0";
  const auth = { Authorization: `Bearer ${RECOVERY_TOKEN}`, "Content-Type": "application/json" };

  try {
    // Seed the recovered workspace exactly the way production holds it.
    await fetch(`${base}/api/draft`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        access_code: RECOVERED_CODE,
        payload: { tax_year: YEAR, trips: trips("Cyprus", "Russia", "Greece") },
      }),
    });

    const inventory = await fetch(`${base}/api/recovery/drafts?tax_year=${YEAR}`, {
      headers: { Authorization: `Bearer ${RECOVERY_TOKEN}` },
    }).then(json);
    const prefix = inventory.drafts.find((d) => d.trip_count === 3).access_code_hash_prefix;
    check("the recovered draft is visible in the inventory", typeof prefix === "string" && prefix.length > 0);

    const unauth = await fetch(`${base}/api/recovery/copy-to-default`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ source_hash_prefix: prefix, tax_year: YEAR }),
    });
    check("copy-to-default without a token is 401", unauth.status === 401);

    const copyRes = await fetch(`${base}/api/recovery/copy-to-default`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ source_hash_prefix: prefix, tax_year: YEAR }),
    });
    const copy = await copyRes.json();
    check("copy-to-default succeeds with a token", copyRes.status === 200 && copy.ok === true, JSON.stringify(copy));
    check("copy-to-default reports the trip count it moved", copy.trip_count === 3);
    check("copy-to-default names the default profile as its target", copy.target === "default_profile");
    check("copy-to-default leaks neither access code", !JSON.stringify(copy).includes(DEFAULT_CODE) && !JSON.stringify(copy).includes(RECOVERED_CODE));

    // This is the migration acceptance test: after the copy, a plain browser
    // hitting the bare URL sees Denis's recovered trips.
    const seen = await fetch(`${base}/api/default-draft?tax_year=${YEAR}`).then(json);
    check(
      "the default profile now serves the recovered trips",
      seen.found === true && seen.payload.trips.map((t) => t.trip_country).join(",") === "Cyprus,Russia,Greece",
      JSON.stringify(seen.payload && seen.payload.trips),
    );

    const source = await fetch(
      `${base}/api/draft?access_code=${encodeURIComponent(RECOVERED_CODE)}&tax_year=${YEAR}`,
    ).then(json);
    check("the source workspace is left intact", source.found === true && source.payload.trips.length === 3);

    const blocked = await fetch(`${base}/api/recovery/copy-to-default`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ source_hash_prefix: prefix, tax_year: YEAR }),
    });
    check("copying onto a populated default needs overwrite=1", blocked.status === 409);

    // Overwriting must archive whatever the default profile held.
    await fetch(`${base}/api/default-draft`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ payload: { tax_year: YEAR, trips: trips("Malta") } }),
    });
    const overwrite = await fetch(`${base}/api/recovery/copy-to-default`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ source_hash_prefix: prefix, tax_year: YEAR, overwrite: "1" }),
    }).then(json);
    check("overwrite=1 replaces the default profile", overwrite.ok === true && overwrite.overwritten === true);
    check("the overwriting copy archives what it replaced", Number.isInteger(overwrite.archived_version_id));

    const archive = await fetch(`${base}/api/default-draft/versions?tax_year=${YEAR}`).then(json);
    check(
      "the replaced list is restorable from the archive UI",
      archive.versions.some((v) => v.countries.includes("Malta")),
      JSON.stringify(archive.versions.map((v) => v.countries)),
    );

    const unknown = await fetch(`${base}/api/recovery/copy-to-default`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ source_hash_prefix: "abcdef123456", tax_year: YEAR }),
    });
    check("copy-to-default 404s on an unknown source prefix", unknown.status === 404);
  } finally {
    await close(server);
  }
}

(async () => {
  try {
    await phaseShared();
    await phaseFallback();
    await phaseVersions();
    await phasePassword();
    await phaseCopyToDefault();
  } catch (err) {
    failures++;
    console.log("  FAIL harness error —", err.stack);
  }

  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch (_) {
    // best effort
  }
  if (failures) {
    console.log(`\n${failures} default-profile check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll default-profile checks passed.");
  process.exit(0);
})();
