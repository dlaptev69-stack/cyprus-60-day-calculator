"use strict";

// Shared adapter, copied unchanged into each independently deployed application.
// It preserves legacy APIs, accepts a project prefix, and verifies gateway context.
const crypto = require("node:crypto");
const net = require("node:net");

const CANONICAL = "https://astravela.space";
const TRANSFER_TTL = 120000;
const keyFor = secret => crypto.createHash("sha256").update(`astravela-transfer-v1:${secret}`).digest();
const equal = (a, b) => {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};
const scriptJSON = value => JSON.stringify(value).replace(/</g, "\\u003c");

function readCookies(raw = "") {
  const result = {};
  for (const part of raw.split(";")) {
    const index = part.indexOf("=");
    if (index < 1) continue;
    const name = part.slice(0, index).trim();
    if (Object.hasOwn(result, name)) continue;
    try { result[name] = decodeURIComponent(part.slice(index + 1).trim()); } catch { /* Ignore malformed cookies. */ }
  }
  return result;
}

function signContext({secret, base, ip, method, path, now = Date.now()}) {
  if (!secret || secret.length < 32) throw new Error("Gateway context secret is not configured");
  const context = Buffer.from(JSON.stringify({v: 1, base, ip, t: now})).toString("base64url");
  const signature = crypto.createHmac("sha256", secret).update(`${context}\n${method}\n${path}`).digest("hex");
  return {context, signature};
}

function verifyContext({secret, base, context, signature, method, path, now = Date.now()}) {
  if (!secret || !context || !signature || context.length > 1024) return null;
  const expected = crypto.createHmac("sha256", secret).update(`${context}\n${method}\n${path}`).digest("hex");
  if (!equal(signature, expected)) return null;
  try {
    const value = JSON.parse(Buffer.from(context, "base64url").toString());
    if (value.v !== 1 || value.base !== base || !net.isIP(value.ip) ||
        !Number.isSafeInteger(value.t) || Math.abs(now - value.t) > 60000) return null;
    return value;
  } catch { return null; }
}

function sealTransfer({secret, base, cookie = "", view = "", challenge = "", now = Date.now()}) {
  if (!secret || secret.length < 32) throw new Error("Transfer secret is not configured");
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", keyFor(secret), iv);
  cipher.setAAD(Buffer.from("astravela-handoff-v1"));
  const payload = JSON.stringify({v: 1, base, cookie, view, challenge, t: now, id: crypto.randomBytes(24).toString("hex")});
  const ciphertext = Buffer.concat([cipher.update(payload, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString("base64url");
}

function openTransfer({secret, base, token, now = Date.now()}) {
  if (!secret || typeof token !== "string" || token.length > 4096) return null;
  try {
    const raw = Buffer.from(token, "base64url");
    if (raw.length < 29) return null;
    const decipher = crypto.createDecipheriv("aes-256-gcm", keyFor(secret), raw.subarray(0, 12));
    decipher.setAAD(Buffer.from("astravela-handoff-v1"));
    decipher.setAuthTag(raw.subarray(12, 28));
    const data = JSON.parse(Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString());
    if (data.v !== 1 || data.base !== base || !Number.isSafeInteger(data.t) ||
        now - data.t > TRANSFER_TTL || data.t > now + 10000 ||
        !/^[a-f0-9]{48}$/.test(data.id) || typeof data.cookie !== "string" ||
        data.cookie.length > 1024 || !["", "admin"].includes(data.view) ||
        typeof data.challenge !== "string" || !/^[a-f0-9]{48}$/.test(data.challenge)) return null;
    return data;
  } catch { return null; }
}

function transferPage({base, cookie, secret, view = "", challenge = "", tracker = false}) {
  const destination = `${CANONICAL}${base}/`;
  const token = tracker ? "" : sealTransfer({secret, base, cookie, view, challenge});
  const code = tracker ? `
    const p = new URLSearchParams(location.hash.slice(1));
    const cookies = {};
    for (const v of document.cookie.split(";")) {
      const i = v.indexOf("="), name = v.slice(0, i).trim();
      if (i > 0 && !(name in cookies)) cookies[name] = v.slice(i + 1);
    }
    let key = p.get("workspace");
    if (!key || key.length < 6 || key.length > 512) {
      try { key = decodeURIComponent(cookies.stw_ws || ""); } catch { key = ""; }
    }
    if (key && (key.length < 6 || key.length > 512)) throw new Error("Stored workspace key needs recovery");
    if (!key) {
      const bytes = crypto.getRandomValues(new Uint8Array(32));
      key = btoa(String.fromCharCode(...bytes)).replace(/\\+/g, "-").replace(/\\//g, "_").replace(/=+$/, "");
    }
    const next = new URL(${scriptJSON(destination)});
    const hash = new URLSearchParams({workspace: key});
    const year = p.get("year") || cookies.stw_year;
    if (year && /^\\d{4}$/.test(year)) hash.set("year", year);
    next.hash = hash.toString();
    location.replace(next.href);
  ` : `
    const next = new URL(${scriptJSON(`${destination}__handoff`)});
    next.hash = new URLSearchParams({
      handoff: ${scriptJSON(token)},
      fragment: location.hash.slice(1, 513)
    }).toString();
    location.replace(next.href);
  `;
  return {code, html: `<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><meta name="robots" content="noindex,nofollow"><meta name="referrer" content="no-referrer"><title>Переход в Astravela</title><body><p>Переношу вход на новый адрес…</p><noscript>Для сохранения входа включи JavaScript.</noscript><script>${code}</script></body></html>`};
}

function namespaceMiddleware({base, cookieName = "", tracker = false, secret = process.env.ASTRAVELA_PROXY_SECRET, canonical = process.env.ASTRAVELA_CANONICAL === "1"}) {
  if (!/^\/[a-z0-9-]+$/.test(base)) throw new Error("Invalid project namespace");
  return (req, res, next) => {
    const context = req.get("x-astravela-context");
    const signature = req.get("x-astravela-signature");
    if (context || signature) {
      const verified = verifyContext({secret, base, context, signature, method: req.method, path: req.url});
      if (!verified) return res.status(403).json({error: "Invalid gateway context"});
      req.astravela = verified;
      Object.defineProperty(req, "ip", {configurable: true, value: verified.ip});
    }
    // Prefix requests also work directly on the old hostname during rollout.
    if (req.url === base || req.url.startsWith(`${base}/`) || req.url.startsWith(`${base}?`)) {
      req.url = req.url.slice(base.length) || "/";
      if (req.url.startsWith("?")) req.url = "/" + req.url;
    }
    const pathname = req.url.split("?")[0];
    const isPage = ["/", "/index.html", "/admin", "/admin/"].includes(pathname);
    const handoff = pathname === "/__astravela_handoff";
    // Old hostnames do not redirect to Astravela. Application pages and personal
    // links exist only under https://astravela.space<base>/; direct requests get 404.
    if (canonical && !req.astravela && ["GET", "HEAD"].includes(req.method) &&
        (isPage || pathname.startsWith("/k/"))) {
      return res.status(404).set({"Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow"})
        .type("text").send("Не найдено");
    }
    if (["GET", "HEAD"].includes(req.method) && !req.astravela &&
        handoff) {
      if (!tracker && (!secret || secret.length < 32)) {
        return res.status(503).type("text").send("Переход пока не готов. Повтори позже.");
      }
      const cookies = readCookies(req.get("cookie"));
      const view = pathname.startsWith("/admin") || req.query.view === "admin" ? "admin" : "";
      const challenge = typeof req.query.challenge === "string" ? req.query.challenge : "";
      if (!tracker && !/^[a-f0-9]{48}$/.test(challenge)) {
        return res.status(400).type("text").send("Начни переход с нового адреса приложения.");
      }
      const page = transferPage({base, cookie: cookies[cookieName] || "", secret, view, tracker, challenge});
      const digest = crypto.createHash("sha256").update(page.code).digest("base64");
      return res.set({
        "Cache-Control": "no-store",
        "Referrer-Policy": "no-referrer",
        "X-Robots-Tag": "noindex, nofollow",
        "Content-Security-Policy": `default-src 'none'; script-src 'sha256-${digest}'; base-uri 'none'; frame-ancestors 'none'`
      }).type("html").send(page.html);
    }
    next();
  };
}

module.exports = {readCookies, signContext, verifyContext, sealTransfer, openTransfer, transferPage, namespaceMiddleware, equal};
