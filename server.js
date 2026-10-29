// MZS Field App server: serves index.html and connects the app to Airtable.
// Secrets live in Render environment variables, never in the app.
//   AIRTABLE_TOKEN     (required) Airtable personal access token
//   AIRTABLE_BASE_ID   (required) starts with "app"
//   WORKER_PIN         (required) code workers type to open the Worker side
//   ANTHROPIC_API_KEY  (optional) turns on the "Write it up for the office" button
//   ANTHROPIC_MODEL    (optional) defaults to claude-haiku-5-5
"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = process.env.PORT || 3000;
const TOKEN = process.env.AIRTABLE_TOKEN || "";
const BASE = process.env.AIRTABLE_BASE_ID || "";
const PIN = process.env.WORKER_PIN || "";
const AI_KEY = process.env.ANTHROPIC_API_KEY || "";
const AI_MODEL = process.env.ANTHROPIC_MODEL || "claude-haiku-5-5";

const REQ_TABLE = "Requests";
const FB_TABLE = "Feedback";

/* ---------- value maps: app code <-> Airtable option ---------- */
const STATUS = { received: "Received", scheduled: "Scheduled", in_progress: "In progress", blocked: "On hold", done: "Done" };
const CAT = { heat: "No heat / hot water", leak: "Leak / water", electric: "Electric / lights", appliance: "Appliance", door: "Door / lock / window", pests: "Pests", building: "Building / hallway", other: "Something else" };
const TIME = { morning: "Morning", afternoon: "Afternoon", anytime: "Anytime" };
const BLOCK = { noAccess: "No access", needParts: "Need parts", needTrade: "Need another trade", notHome: "Tenant not home", anotherDay: "Need another day" };
const LANG = { en: "English", es: "Spanish" };
const SCREEN = { general: "General / whole app", tenantForm: "Tenant: Report a problem", tenantMine: "Tenant: My requests", workerJobs: "Worker: Job list", workerJob: "Worker: A job", airtable: "Airtable fields" };
const KIND = { bug: "Something's broken", change: "Change this", idea: "New idea", missing: "Something's missing" };

const REQ_FIELDS = ["Ticket #","Status","Urgent","Problem type","Building address","Apartment","Tenant name","Tenant phone","Tenant description","Best time","Tenant photos","Visit date","Visit time","Started at","Finished at","Before photos","After photos","Worker notes","Office write-up","On-hold reason","Reopened","Flagged by worker","Tenant language","Created at","Last updated"];
const FB_FIELDS = ["Feedback","Screen","Type","Handled","Created at"];
const PHOTO_FIELD = { tenant: "Tenant photos", before: "Before photos", after: "After photos" };

const norm = s => String(s == null ? "" : s).replace(/[\u2018\u2019]/g, "'").trim().toLowerCase();
const codeOf = (map, label) => { const n = norm(label); for (const [k, v] of Object.entries(map)) if (norm(v) === n) return k; return null; };

/* ---------- Airtable ---------- */
let schema = { choices: {}, missing: [], loaded: false, error: "" };

async function at(method, urlPath, body, host) {
  const r = await fetch((host || "https://api.airtable.com") + urlPath, {
    method,
    headers: { Authorization: "Bearer " + TOKEN, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    const msg = (j && j.error && (j.error.message || j.error.type)) || ("Airtable error " + r.status);
    const e = new Error(msg); e.status = r.status >= 500 ? 502 : 400; throw e;
  }
  return j;
}
const tablePath = t => "/v0/" + BASE + "/" + encodeURIComponent(t);

async function loadSchema() {
  try {
    const j = await at("GET", "/v0/meta/bases/" + BASE + "/tables");
    const choices = {}, missing = [];
    const found = {};
    for (const t of j.tables || []) {
      found[t.name] = new Set((t.fields || []).map(f => f.name));
      choices[t.name] = {};
      for (const f of t.fields || []) if (f.options && f.options.choices) choices[t.name][f.name] = f.options.choices.map(c => c.name);
    }
    for (const [tName, list] of [[REQ_TABLE, REQ_FIELDS], [FB_TABLE, FB_FIELDS]]) {
      if (!found[tName]) { missing.push("table: " + tName); continue; }
      for (const f of list) if (!found[tName].has(f)) missing.push(tName + ": " + f);
    }
    schema = { choices, missing, loaded: true, error: "" };
    if (missing.length) console.warn("Airtable is missing:", missing.join(", "));
  } catch (e) {
    schema.error = e.message;
    console.error("Could not read Airtable schema:", e.message);
  }
}
// Use the exact option name Airtable has (handles curly vs straight apostrophes)
function opt(table, field, label) {
  const list = (schema.choices[table] || {})[field];
  if (!list) return label;
  return list.find(c => norm(c) === norm(label)) || label;
}

/* ---------- record <-> app shape ---------- */
const ms = v => (v ? Date.parse(v) || null : null);
const att = a => (Array.isArray(a) ? a : []).map(x => ({ url: x.url, type: x.type || "", name: x.filename || "", thumb: x.thumbnails && x.thumbnails.large ? x.thumbnails.large.url : "" }));

function jobOut(rec) {
  const f = rec.fields || {};
  return {
    id: rec.id,
    ticket: f["Ticket #"] || "",
    status: codeOf(STATUS, f["Status"]) || "received",
    urgent: !!f["Urgent"],
    category: codeOf(CAT, f["Problem type"]) || "other",
    building: f["Building address"] || "",
    apt: f["Apartment"] || "",
    name: f["Tenant name"] || "",
    phone: f["Tenant phone"] || "",
    details: f["Tenant description"] || "",
    timePref: codeOf(TIME, f["Best time"]) || "anytime",
    photos: att(f["Tenant photos"]),
    visit: f["Visit date"] ? { date: f["Visit date"], slot: codeOf(TIME, f["Visit time"]) || "anytime" } : null,
    startedAt: ms(f["Started at"]),
    finishedAt: ms(f["Finished at"]),
    beforePhotos: att(f["Before photos"]),
    afterPhotos: att(f["After photos"]),
    notes: f["Worker notes"] || "",
    writeup: f["Office write-up"] || "",
    blockReason: codeOf(BLOCK, f["On-hold reason"]),
    reopened: !!f["Reopened"],
    byWorker: !!f["Flagged by worker"],
    lang: codeOf(LANG, f["Tenant language"]) || "en",
    createdAt: ms(f["Created at"]) || ms(rec.createdTime)
  };
}
// What a tenant sees about their own request (no worker notes)
function tenantOut(rec) {
  const j = jobOut(rec);
  return { id: j.id, ticket: j.ticket, status: j.status, category: j.category, visit: j.visit, createdAt: j.createdAt, finishedAt: j.finishedAt, reopened: j.reopened, afterPhotos: j.afterPhotos, byWorker: j.byWorker };
}

function bad(msg) { const e = new Error(msg); e.status = 400; return e; }
const str = (v, max) => String(v == null ? "" : v).slice(0, max || 500);
function pick(map, v, name, allowNull) {
  if (v == null || v === "") { if (allowNull) return null; throw bad("Missing " + name); }
  if (!map[v]) throw bad("Unknown " + name);
  return map[v];
}

// Turn an app patch into Airtable fields. Only known keys pass through.
function jobFields(p) {
  const F = {}, has = k => Object.prototype.hasOwnProperty.call(p, k);
  if (has("status")) F["Status"] = opt(REQ_TABLE, "Status", pick(STATUS, p.status, "status"));
  if (has("urgent")) F["Urgent"] = !!p.urgent;
  if (has("category")) F["Problem type"] = opt(REQ_TABLE, "Problem type", pick(CAT, p.category, "problem type"));
  if (has("building")) F["Building address"] = str(p.building, 300);
  if (has("apt")) F["Apartment"] = str(p.apt, 40);
  if (has("name")) F["Tenant name"] = str(p.name, 120);
  if (has("phone")) F["Tenant phone"] = str(p.phone, 40);
  if (has("details")) F["Tenant description"] = str(p.details, 5000);
  if (has("timePref")) F["Best time"] = opt(REQ_TABLE, "Best time", pick(TIME, p.timePref, "best time"));
  if (has("visit")) {
    if (!p.visit) { F["Visit date"] = null; F["Visit time"] = null; }
    else {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(p.visit.date || ""))) throw bad("Bad visit date");
      F["Visit date"] = p.visit.date;
      F["Visit time"] = opt(REQ_TABLE, "Visit time", pick(TIME, p.visit.slot || "anytime", "visit time"));
    }
  }
  for (const [k, name] of [["startedAt", "Started at"], ["finishedAt", "Finished at"]]) {
    if (has(k)) F[name] = p[k] ? new Date(Number(p[k])).toISOString() : null;
  }
  if (has("notes")) F["Worker notes"] = str(p.notes, 10000);
  if (has("writeup")) F["Office write-up"] = str(p.writeup, 10000);
  if (has("blockReason")) { const b = pick(BLOCK, p.blockReason, "reason", true); F["On-hold reason"] = b ? opt(REQ_TABLE, "On-hold reason", b) : null; }
  if (has("reopened")) F["Reopened"] = !!p.reopened;
  if (has("lang")) F["Tenant language"] = opt(REQ_TABLE, "Tenant language", pick(LANG, p.lang || "en", "language"));
  return F;
}

async function listAll(table, params) {
  const out = [];
  let offset = "";
  for (let i = 0; i < 20; i++) {
    const q = new URLSearchParams(Object.assign({ pageSize: "100" }, params || {}));
    if (offset) q.set("offset", offset);
    const j = await at("GET", tablePath(table) + "?" + q.toString());
    out.push(...(j.records || []));
    if (!j.offset) break;
    offset = j.offset;
  }
  return out;
}
const getRec = id => at("GET", tablePath(REQ_TABLE) + "/" + id);
const patchRec = (id, fields) => { jobsCache = null; return at("PATCH", tablePath(REQ_TABLE) + "/" + id, { fields, typecast: true }); };

// Short cache so several open phones don't each hit Airtable (saves API calls on the Free plan)
const CACHE_MS = Number(process.env.CACHE_SECONDS || 30) * 1000;
let jobsCache = null, jobsAt = 0;
async function allJobs() {
  if (jobsCache && Date.now() - jobsAt < CACHE_MS) return jobsCache;
  jobsCache = (await listAll(REQ_TABLE)).map(jobOut); jobsAt = Date.now();
  return jobsCache;
}

/* ---------- helpers ---------- */
const send = (res, code, obj) => {
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(obj));
};
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on("data", c => { size += c.length; if (size > limit) { reject(Object.assign(new Error("Upload too large"), { status: 413 })); req.destroy(); } else chunks.push(c); });
    req.on("end", () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {}); } catch (e) { reject(bad("Bad JSON")); } });
    req.on("error", reject);
  });
}
function pinOk(req) {
  if (!PIN) return false;
  const given = String(req.headers["x-worker-pin"] || "");
  const a = crypto.createHash("sha256").update(given).digest();
  const b = crypto.createHash("sha256").update(PIN).digest();
  return crypto.timingSafeEqual(a, b);
}
function needPin(req) {
  if (!PIN) throw Object.assign(new Error("WORKER_PIN is not set on the server"), { status: 503 });
  if (!pinOk(req)) throw Object.assign(new Error("Wrong PIN"), { status: 401 });
}
const hits = new Map();
function limit(req, max) {
  const ip = String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim();
  const now = Date.now(), win = 10 * 60 * 1000;
  const h = (hits.get(ip) || []).filter(t => now - t < win);
  h.push(now); hits.set(ip, h);
  if (h.length > max) throw Object.assign(new Error("Too many requests. Try again in a few minutes."), { status: 429 });
}
const isRec = id => /^rec[A-Za-z0-9]{14}$/.test(id);
const digits = s => String(s || "").replace(/\D/g, "");
const esc = s => String(s).replace(/\\/g, "\\\\").replace(/'/g, "\\'");
const ticket = () => String(Date.now()).slice(-6);

async function uploadPhoto(id, field, b) {
  const type = String(b.contentType || "");
  if (!/^(image|video)\//.test(type)) throw bad("Only photos or videos");
  const data = String(b.data || "");
  if (!data || Buffer.byteLength(data, "base64") > 5 * 1024 * 1024) throw Object.assign(new Error("File too large (5 MB max)"), { status: 413 });
  await at("POST", "/v0/" + BASE + "/" + id + "/" + encodeURIComponent(field) + "/uploadAttachment",
    { contentType: type, file: data, filename: str(b.filename || "photo", 100) }, "https://content.airtable.com");
}

/* ---------- routes ---------- */
async function api(req, res, url) {
  const p = url.pathname, m = req.method;
  let r;

  if (m === "GET" && p === "/api/config") return send(res, 200, { writeup: !!AI_KEY, pinSet: !!PIN });

  if (m === "GET" && p === "/api/health") {
    needPin(req);
    if (!schema.loaded) await loadSchema();
    return send(res, 200, { ok: schema.loaded && !schema.missing.length, missing: schema.missing, error: schema.error });
  }

  // Tenant (or worker) sends a new request
  if (m === "POST" && p === "/api/requests") {
    limit(req, 40);
    const b = await readBody(req, 50 * 1024);
    const worker = pinOk(req);
    if (!str(b.apt).trim() || !digits(b.phone) && !worker || !CAT[b.category]) throw bad("Apartment, phone, and problem are required");
    const F = jobFields({ building: b.building, apt: b.apt, phone: b.phone, name: b.name, category: b.category, details: b.details, timePref: b.timePref || "anytime", lang: b.lang === "es" ? "es" : "en", status: "received" });
    F["Ticket #"] = ticket();
    F["Urgent"] = b.category === "heat" || b.category === "leak";
    F["Flagged by worker"] = worker && !!b.byWorker;
    const rec = await at("POST", tablePath(REQ_TABLE), { fields: F, typecast: true });
    jobsCache = null;
    return send(res, 200, { id: rec.id, ticket: F["Ticket #"] });
  }

  // Photo upload: tenants only within 1 hour of sending; workers any time
  if (m === "POST" && (r = p.match(/^\/api\/requests\/(rec\w+)\/photos$/))) {
    limit(req, 80);
    const id = r[1]; if (!isRec(id)) throw bad("Bad id");
    const b = await readBody(req, 8 * 1024 * 1024);
    const field = PHOTO_FIELD[b.field]; if (!field) throw bad("Bad photo field");
    const worker = pinOk(req);
    if (!worker) {
      if (b.field !== "tenant") needPin(req);
      const rec = await getRec(id);
      if (Date.now() - Date.parse(rec.createdTime) > 60 * 60 * 1000) throw Object.assign(new Error("Too late to add photos"), { status: 403 });
    }
    await uploadPhoto(id, field, b);
    jobsCache = null;
    const rec = await getRec(id);
    return send(res, 200, worker ? jobOut(rec) : tenantOut(rec));
  }

  // Tenant looks up their own requests by phone + apartment
  if (m === "POST" && p === "/api/my") {
    limit(req, 120);
    const b = await readBody(req, 4 * 1024);
    const ph = digits(b.phone), apt = str(b.apt, 40).trim().toLowerCase();
    if (ph.length < 7 || !apt) throw bad("Enter your phone and apartment");
    const formula = "AND(LOWER(TRIM({Apartment}&''))='" + esc(apt) + "',REGEX_REPLACE({Tenant phone}&'','[^0-9]','')='" + esc(ph) + "')";
    const recs = await listAll(REQ_TABLE, { filterByFormula: formula });
    return send(res, 200, recs.map(tenantOut));
  }

  if (m === "POST" && (r = p.match(/^\/api\/my\/(rec\w+)\/reopen$/))) {
    limit(req, 40);
    const id = r[1]; if (!isRec(id)) throw bad("Bad id");
    const b = await readBody(req, 4 * 1024);
    const rec = await getRec(id), f = rec.fields || {};
    if (digits(f["Tenant phone"]) !== digits(b.phone) || norm(f["Apartment"]) !== norm(b.apt)) throw Object.assign(new Error("Not your request"), { status: 403 });
    await patchRec(id, jobFields({ status: "received", reopened: true, finishedAt: null, startedAt: null, visit: null, blockReason: null }));
    return send(res, 200, { ok: true });
  }

  // Worker: all jobs
  if (m === "GET" && p === "/api/jobs") {
    needPin(req);
    return send(res, 200, await allJobs());
  }

  if (m === "PATCH" && (r = p.match(/^\/api\/jobs\/(rec\w+)$/))) {
    needPin(req);
    const id = r[1]; if (!isRec(id)) throw bad("Bad id");
    const b = await readBody(req, 64 * 1024);
    const F = jobFields(b);
    if (!Object.keys(F).length) throw bad("Nothing to save");
    const rec = await patchRec(id, F);
    return send(res, 200, jobOut(rec));
  }

  if (m === "POST" && p === "/api/writeup") {
    needPin(req);
    if (!AI_KEY) throw Object.assign(new Error("Write-up is not turned on"), { status: 503 });
    const b = await readBody(req, 32 * 1024);
    if (!isRec(String(b.id || ""))) throw bad("Bad id");
    const j = jobOut(await getRec(b.id));
    const notes = str(b.notes != null ? b.notes : j.notes, 8000);
    const prompt = "You write short job reports for a property maintenance office. Write in plain English, even if the notes are in Spanish or another language (translate them).\n" +
      "Use exactly these four labeled lines, each one short:\nProblem found:\nWhat was fixed:\nParts used:\nFollow-up needed:\n" +
      "If something isn't known from the notes, write \"[not noted]\". No extra text before or after.\n\n" +
      "Job type: " + CAT[j.category] + "\nTenant's description: " + (j.details || "(none)") + "\nWorker's notes: " + (notes || "(none)") +
      "\nStatus: " + STATUS[j.status] + (j.blockReason ? " (" + BLOCK[j.blockReason] + ")" : "");
    const ar = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": AI_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model: AI_MODEL, max_tokens: 400, messages: [{ role: "user", content: prompt }] })
    });
    const aj = await ar.json().catch(() => ({}));
    if (!ar.ok) { console.error("Anthropic error:", aj && aj.error); throw Object.assign(new Error("Write-up failed"), { status: 502 }); }
    const text = (aj.content || []).filter(c => c.type === "text").map(c => c.text).join("\n").trim();
    return send(res, 200, { text });
  }

  // Feedback: anyone with the link can send; only workers can read
  if (m === "POST" && p === "/api/feedback") {
    limit(req, 40);
    const b = await readBody(req, 16 * 1024);
    const text = str(b.text, 5000).trim(); if (!text) throw bad("Write your feedback");
    const F = {
      "Feedback": text,
      "Screen": opt(FB_TABLE, "Screen", pick(SCREEN, b.screen || "general", "screen")),
      "Type": opt(FB_TABLE, "Type", pick(KIND, b.kind || "change", "type")),
      "Handled": false
    };
    await at("POST", tablePath(FB_TABLE), { fields: F, typecast: true });
    return send(res, 200, { ok: true });
  }
  if (m === "GET" && p === "/api/feedback") {
    needPin(req);
    const recs = await listAll(FB_TABLE);
    return send(res, 200, recs.map(rec => {
      const f = rec.fields || {};
      return { id: rec.id, text: f["Feedback"] || "", screen: codeOf(SCREEN, f["Screen"]) || "general", kind: codeOf(KIND, f["Type"]) || "change", handled: !!f["Handled"], createdAt: ms(f["Created at"]) || ms(rec.createdTime) };
    }));
  }
  if (m === "PATCH" && (r = p.match(/^\/api\/feedback\/(rec\w+)$/))) {
    needPin(req);
    const id = r[1]; if (!isRec(id)) throw bad("Bad id");
    const b = await readBody(req, 4 * 1024);
    await at("PATCH", tablePath(FB_TABLE) + "/" + id, { fields: { "Handled": !!b.handled } });
    return send(res, 200, { ok: true });
  }

  send(res, 404, { error: "Not found" });
}

const INDEX = path.join(__dirname, "index.html");
const server = http.createServer(async (req, res) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  const url = new URL(req.url, "http://x");
  if (url.pathname.startsWith("/api/")) {
    if (!TOKEN || !BASE) return send(res, 503, { error: "Server is missing AIRTABLE_TOKEN or AIRTABLE_BASE_ID" });
    try { await api(req, res, url); }
    catch (e) {
      const code = e.status || 500;
      if (code >= 500) console.error(req.method, url.pathname, e.message);
      if (!res.headersSent) send(res, code, { error: code === 500 ? "Server error" : e.message });
    }
    return;
  }
  if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
    fs.readFile(INDEX, (err, buf) => {
      if (err) { res.writeHead(500); return res.end("index.html missing"); }
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" });
      res.end(buf);
    });
    return;
  }
  res.writeHead(404, { "Content-Type": "text/plain" }); res.end("Not found");
});

server.listen(PORT, () => {
  console.log("MZS Field App running on port " + PORT);
  if (!TOKEN || !BASE) console.warn("Set AIRTABLE_TOKEN and AIRTABLE_BASE_ID in Render > Environment.");
  if (!PIN) console.warn("Set WORKER_PIN in Render > Environment.");
  if (TOKEN && BASE) loadSchema();
});
