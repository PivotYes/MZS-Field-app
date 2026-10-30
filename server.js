// MZS Field App server: serves index.html and connects the app to Airtable.
// Secrets live in Render environment variables, never in the app.
//   AIRTABLE_TOKEN     (required) Airtable personal access token
//   AIRTABLE_BASE_ID   (required) starts with "app"
//   WORKER_PIN         (required) code workers type to open the Worker side
//   OFFICE_PIN         (required for tenant messages) code the office types to open the Office side
//   ANTHROPIC_API_KEY  (optional) turns on the "Write it up for the office" button and the tenant AI assistant
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
const OFFICE_PIN = process.env.OFFICE_PIN || "";
const AI_KEY = process.env.ANTHROPIC_API_KEY || "";
const AI_MODEL = process.env.ANTHROPIC_MODEL || "claude-haiku-5-5";

const REQ_TABLE = "Requests";
const FB_TABLE = "Feedback";
const MSG_TABLE = "Messages";

/* ---------- value maps: app code <-> Airtable option ---------- */
const STATUS = { received: "Received", scheduled: "Scheduled", in_progress: "In progress", blocked: "On hold", done: "Done" };
const CAT = { heat: "No heat / hot water", leak: "Leak / water", electric: "Electric / lights", appliance: "Appliance", door: "Door / lock / window", pests: "Pests", building: "Building / hallway", other: "Something else" };
const TIME = { morning: "Morning", afternoon: "Afternoon", anytime: "Anytime" };
const BLOCK = { noAccess: "No access", needParts: "Need parts", needTrade: "Need another trade", notHome: "Tenant not home", anotherDay: "Need another day" };
const LANG = { en: "English", es: "Spanish" };
const SCREEN = { general: "General / whole app", tenantForm: "Tenant: Report a problem", tenantMine: "Tenant: My requests", workerJobs: "Worker: Job list", workerJob: "Worker: A job", airtable: "Airtable fields" };
const FROM = { tenant: "Tenant", office: "Office" };
const KIND = { bug: "Something's broken", change: "Change this", idea: "New idea", missing: "Something's missing" };

const REQ_FIELDS = ["Ticket #","Status","Urgent","Problem type","Building address","Apartment","Tenant name","Tenant phone","Tenant description","Best time","Tenant photos","Visit date","Visit time","Started at","Finished at","Before photos","After photos","Worker notes","Office write-up","On-hold reason","Reopened","Flagged by worker","Tenant language","Created at","Last updated"];
const FB_FIELDS = ["Feedback","Screen","Type","Handled","Created at"];
const MSG_FIELDS = ["Request","From","Message","Created at"];
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
    for (const [tName, list] of [[REQ_TABLE, REQ_FIELDS], [FB_TABLE, FB_FIELDS], [MSG_TABLE, MSG_FIELDS]]) {
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

// Tenant <-> office messages. Workers never get these.
function msgOut(rec) {
  const f = rec.fields || {};
  return { id: rec.id, req: (f["Request"] || [])[0] || "", from: codeOf(FROM, f["From"]) || "tenant", text: f["Message"] || "", at: ms(f["Created at"]) || ms(rec.createdTime) };
}
const threadOf = (msgs, id) => msgs.filter(m => m.req === id).sort((a, b) => (a.at || 0) - (b.at || 0));

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

let msgsCache = null, msgsAt = 0;
async function allMsgs() {
  if (msgsCache && Date.now() - msgsAt < CACHE_MS) return msgsCache;
  msgsCache = (await listAll(MSG_TABLE)).map(msgOut); msgsAt = Date.now();
  return msgsCache;
}
async function addMsg(id, from, text) {
  await at("POST", tablePath(MSG_TABLE), { fields: { "Request": [id], "From": opt(MSG_TABLE, "From", FROM[from]), "Message": text }, typecast: true });
  msgsCache = null;
  return threadOf(await allMsgs(), id);
}
function msgText(b) {
  const text = str(b.text, 2000).trim();
  if (!text) throw bad("Write a message");
  return text;
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
function codeOk(given, secret) {
  if (!secret) return false;
  const a = crypto.createHash("sha256").update(String(given || "")).digest();
  const b = crypto.createHash("sha256").update(secret).digest();
  return crypto.timingSafeEqual(a, b);
}
const pinOk = req => codeOk(req.headers["x-worker-pin"], PIN);
const officeOk = req => codeOk(req.headers["x-office-pin"], OFFICE_PIN);
function needPin(req) {
  if (!PIN) throw Object.assign(new Error("WORKER_PIN is not set on the server"), { status: 503 });
  if (!pinOk(req)) throw Object.assign(new Error("Wrong PIN"), { status: 401 });
}
function needOffice(req) {
  if (!OFFICE_PIN) throw Object.assign(new Error("OFFICE_PIN is not set on the server"), { status: 503 });
  if (!officeOk(req)) throw Object.assign(new Error("Wrong PIN"), { status: 401 });
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
// A tenant's own requests, found by the phone + apartment they sent them with
function myRecs(phone, apt) {
  const ph = digits(phone), a = str(apt, 40).trim().toLowerCase();
  if (ph.length < 7 || !a) throw bad("Enter your phone and apartment");
  const formula = "AND(LOWER(TRIM({Apartment}&''))='" + esc(a) + "',REGEX_REPLACE({Tenant phone}&'','[^0-9]','')='" + esc(ph) + "')";
  return listAll(REQ_TABLE, { filterByFormula: formula });
}
// Tenant proves a request is theirs with the phone + apartment they sent it with
async function ownRec(id, b) {
  if (!isRec(id)) throw bad("Bad id");
  const rec = await getRec(id), f = rec.fields || {};
  if (digits(f["Tenant phone"]) !== digits(b.phone) || norm(f["Apartment"]) !== norm(b.apt)) throw Object.assign(new Error("Not your request"), { status: 403 });
  return rec;
}

async function uploadPhoto(id, field, b) {
  const type = String(b.contentType || "");
  if (!/^(image|video)\//.test(type)) throw bad("Only photos or videos");
  const data = String(b.data || "");
  if (!data || Buffer.byteLength(data, "base64") > 5 * 1024 * 1024) throw Object.assign(new Error("File too large (5 MB max)"), { status: 413 });
  await at("POST", "/v0/" + BASE + "/" + id + "/" + encodeURIComponent(field) + "/uploadAttachment",
    { contentType: type, file: data, filename: str(b.filename || "photo", 100) }, "https://content.airtable.com");
}

/* ---------- tenant AI assistant ---------- */
const ASSIST_TOOLS = [
  { name: "get_my_requests", description: "Look up this tenant's own maintenance requests: status, scheduled visit, and recent office messages. Call this before answering any question about a request.",
    input_schema: { type: "object", properties: {}, additionalProperties: false } },
  { name: "propose_request", description: "Show the tenant a new maintenance request to confirm. Nothing is sent until the tenant taps Yes on the summary. Only call once you know the problem type and what is wrong.",
    input_schema: { type: "object", properties: {
      category: { type: "string", enum: Object.keys(CAT), description: "heat = no heat / hot water, leak = leak / water, electric = electric / lights, appliance, door = door / lock / window, pests, building = building / hallway, other" },
      details: { type: "string", description: "Short description of the problem in the tenant's words" },
      time_pref: { type: "string", enum: Object.keys(TIME), description: "Best time for maintenance to come in" }
    }, required: ["category", "details", "time_pref"], additionalProperties: false } },
  { name: "connect_to_office", description: "Send the tenant's question to the office chat on one of their open requests, when you don't have the answer or aren't allowed to answer it.",
    input_schema: { type: "object", properties: {
      request_id: { type: "string", description: "The id of the tenant's open request the question is about" },
      question: { type: "string", description: "The tenant's question, in their words" }
    }, required: ["request_id", "question"], additionalProperties: false } }
];
const HANDOFF = {
  en: "Connecting you to the office... Your question was sent. Their reply will show up here and in My requests.",
  es: "Conectándolo con la oficina... Su pregunta fue enviada. La respuesta aparecerá aquí y en Mis solicitudes."
};

function assistSystem(lang) {
  return [
    "You are the MZS maintenance assistant inside the MZS tenant app. You talk with one tenant at a time.",
    "Reply in " + (lang === "es" ? "Spanish" : "English") + ". Keep replies short and plain: 1-4 sentences, no markdown headings.",
    "",
    "You can help with only these things:",
    "1. Status of the tenant's own requests. Always call get_my_requests first; answer only from what it returns. Never guess dates or promise times.",
    "2. Simple, safe fix-it tips a tenant can do themselves: resetting a tripped breaker, plunging a clogged toilet or drain, resetting a garbage disposal, checking thermostat settings or batteries, turning off a fixture's shut-off valve to stop a leak. If a fix needs tools, a ladder, opening walls or panels, gas, or wiring, don't give steps: offer to submit a request.",
    "3. Submitting a new request. Ask for what's missing (what's wrong, details, best time: morning, afternoon, or anytime), then call propose_request. The tenant confirms on screen. Don't say it was sent.",
    "",
    "Rules:",
    "- Fire, gas smell, flooding, sparks, or anyone in danger: tell them to call 911 now, then the MZS emergency line [MZS emergency line]. Nothing else first.",
    "- Photos and videos can't be sent in this chat. If the tenant wants to send one, tell them to use the Report a problem form.",
    "- If the tenant asks something about one of their requests that you don't have the answer to or aren't allowed to answer (for example changing the visit time, who is coming, costs, building policies, complaints), call connect_to_office. If they have more than one open request, ask which one first. If they have no open request, say so and offer to submit one.",
    "- If the question has nothing to do with their requests or a repair, politely say you can only help with maintenance and offer to submit a request. Don't send it to the office.",
    "- Don't make up information about the building, staff, schedules, or rules."
  ].join("\n");
}

async function assist(b) {
  const lang = b.lang === "es" ? "es" : "en";
  // Text-only history from the app; must start with the tenant
  const history = (Array.isArray(b.history) ? b.history : []).slice(-20)
    .map(h => ({ role: h.role === "assistant" ? "assistant" : "user", content: str(h.text, 2000).trim() }))
    .filter(h => h.content);
  while (history.length && history[0].role !== "user") history.shift();
  if (!history.length || history[history.length - 1].role !== "user") throw bad("Write a message");

  const recs = await myRecs(b.phone, b.apt);
  const mine = recs.map(jobOut).filter(j => !j.byWorker);
  let msgs = [];
  try { msgs = await allMsgs(); } catch (e) { console.error("Could not read messages:", e.message); }
  const out = { reply: "", draft: null, handoff: null };

  function runTool(name, input) {
    if (name === "get_my_requests") {
      if (!mine.length) return "This tenant has no requests.";
      return JSON.stringify(mine.map(j => ({
        request_id: j.id, ticket: j.ticket, problem: CAT[j.category], status: j.status === "done" ? "Fixed" : STATUS[j.status],
        reopened: j.reopened, sent_on: j.createdAt ? new Date(j.createdAt).toISOString().slice(0, 10) : null,
        visit: j.visit && j.status !== "done" ? j.visit.date + " (" + TIME[j.visit.slot] + ")" : null,
        fixed_on: j.finishedAt ? new Date(j.finishedAt).toISOString().slice(0, 10) : null,
        recent_office_messages: j.status === "done" ? [] : threadOf(msgs, j.id).slice(-3).map(m => m.from + ": " + m.text)
      })));
    }
    if (name === "propose_request") {
      if (!CAT[input.category]) throw new Error("Unknown category");
      out.draft = { category: input.category, details: str(input.details, 2000).trim(), timePref: TIME[input.time_pref] ? input.time_pref : "anytime" };
      return "Summary shown to the tenant with Yes / No buttons. In one short sentence, ask them to check it and tap Yes to send.";
    }
    if (name === "connect_to_office") {
      const j = mine.find(x => x.id === input.request_id && x.status !== "done");
      if (!j) throw new Error("That is not one of this tenant's open requests. Their open requests: " + (mine.filter(x => x.status !== "done").map(x => x.id + " (" + CAT[x.category] + ")").join(", ") || "none"));
      out.handoff = { id: j.id, ticket: j.ticket, question: str(input.question, 2000).trim() };
      return "Sent to the office.";
    }
    throw new Error("Unknown tool");
  }

  const messages = history.slice();
  for (let i = 0; i < 6; i++) {
    const ar = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": AI_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model: AI_MODEL, max_tokens: 4000, output_config: { effort: "low" }, system: assistSystem(lang), tools: ASSIST_TOOLS, messages })
    });
    const aj = await ar.json().catch(() => ({}));
    if (!ar.ok) { console.error("Anthropic error:", aj && aj.error); throw Object.assign(new Error("The assistant isn't available right now"), { status: 502 }); }
    if (aj.stop_reason === "refusal") break;
    const content = aj.content || [];
    out.reply = content.filter(c => c.type === "text").map(c => c.text).join("\n").trim();
    if (aj.stop_reason !== "tool_use") break;
    // Keep the full assistant turn (thinking + tool calls) and answer every tool call in one user turn
    messages.push({ role: "assistant", content });
    const results = [];
    for (const c of content.filter(x => x.type === "tool_use")) {
      try { results.push({ type: "tool_result", tool_use_id: c.id, content: runTool(c.name, c.input || {}) }); }
      catch (e) { results.push({ type: "tool_result", tool_use_id: c.id, content: e.message, is_error: true }); }
    }
    messages.push({ role: "user", content: results });
  }

  if (out.handoff) {
    await addMsg(out.handoff.id, "tenant", out.handoff.question || history[history.length - 1].content);
    out.reply = HANDOFF[lang];
  }
  if (!out.reply) out.reply = lang === "es" ? "No pude contestar eso. Intente otra vez o use Mis solicitudes para escribir a la oficina." : "I couldn't answer that. Try again, or use My requests to message the office.";
  return out;
}

/* ---------- routes ---------- */
async function api(req, res, url) {
  const p = url.pathname, m = req.method;
  let r;

  if (m === "GET" && p === "/api/config") return send(res, 200, { writeup: !!AI_KEY, assist: !!AI_KEY, pinSet: !!PIN, officeSet: !!OFFICE_PIN });

  if (m === "GET" && p === "/api/health") {
    if (!officeOk(req)) needPin(req);
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
    const recs = await myRecs(b.phone, b.apt);
    let msgs = [];
    try { msgs = await allMsgs(); } catch (e) { console.error("Could not read messages:", e.message); }
    // Messages only show on open (or reopened) requests, not finished ones
    return send(res, 200, recs.map(rec => { const o = tenantOut(rec); o.messages = o.status === "done" ? [] : threadOf(msgs, o.id); return o; }));
  }

  // Tenant sends the office a message about one of their open requests
  if (m === "POST" && (r = p.match(/^\/api\/my\/(rec\w+)\/messages$/))) {
    limit(req, 60);
    const b = await readBody(req, 8 * 1024);
    const text = msgText(b);
    const rec = await ownRec(r[1], b);
    if (jobOut(rec).status === "done") throw Object.assign(new Error("This request is finished. Reopen it to send a message."), { status: 403 });
    return send(res, 200, { messages: await addMsg(rec.id, "tenant", text) });
  }

  if (m === "POST" && (r = p.match(/^\/api\/my\/(rec\w+)\/reopen$/))) {
    limit(req, 40);
    const b = await readBody(req, 4 * 1024);
    const id = (await ownRec(r[1], b)).id;
    await patchRec(id, jobFields({ status: "received", reopened: true, finishedAt: null, startedAt: null, visit: null, blockReason: null }));
    return send(res, 200, { ok: true });
  }

  // Office: open requests plus finished ones that have messages
  if (m === "GET" && p === "/api/office") {
    needOffice(req);
    const [jobs, msgs] = await Promise.all([allJobs(), allMsgs()]);
    const out = jobs.map(j => Object.assign({}, j, { messages: threadOf(msgs, j.id) }))
      .filter(j => j.status !== "done" || j.messages.length);
    return send(res, 200, out);
  }

  if (m === "POST" && (r = p.match(/^\/api\/office\/(rec\w+)\/messages$/))) {
    needOffice(req);
    const id = r[1]; if (!isRec(id)) throw bad("Bad id");
    const b = await readBody(req, 8 * 1024);
    const text = msgText(b);
    if (jobOut(await getRec(id)).status === "done") throw bad("This request is finished. The tenant can't see new messages.");
    return send(res, 200, { messages: await addMsg(id, "office", text) });
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

  // Tenant AI assistant: answers request status + simple fix-it tips, drafts requests, hands off to the office
  if (m === "POST" && p === "/api/assist") {
    limit(req, 60);
    if (!AI_KEY) throw Object.assign(new Error("The assistant is not turned on"), { status: 503 });
    const b = await readBody(req, 64 * 1024);
    return send(res, 200, await assist(b));
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
  if (!OFFICE_PIN) console.warn("Set OFFICE_PIN in Render > Environment to turn on tenant messages.");
  if (TOKEN && BASE) loadSchema();
});
