#!/usr/bin/env node
/**
 * Lead finder: pulls company / MSME records from data.gov.in for all of India,
 * keeps the ones that fit a target profile (default: EV charge point operators), and
 *   - appends each new lead to a Google Sheet (so the team can track outreach)
 *   - keeps local CSVs in ./output
 *   - remembers its progress in ./state, so a restart (nodemon, reboot, crash)
 *     continues where it stopped instead of starting over.
 *
 * It is deliberately slow and polite to data.gov.in: one request at a time, a few
 * seconds apart, slowing down by itself when told to, and a daily request cap.
 *
 * Needs Node.js 18+. No npm packages (nodemon is only used to run it).
 *
 * Configuration comes from a .env file next to this script (see .env.example).
 * Command-line options override it:
 *   --key KEY  --resource ID[,ID]  --profile cpo|ev|energy|raw
 *   --states ALL|NONE|MAHARASHTRA,KARNATAKA  --districts PUNE,THANE
 *   --filter Field=Value[;Field=Value]  --page-size N  --delay SECONDS  --max N
 *   --all-statuses
 *   --reset     forget saved progress and plans, start from the beginning
 *   --no-sheet  don't send anything to Google Sheets (for tests)
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const ROOT = __dirname;
const STATE_DIR = path.join(ROOT, "state");
const OUT_DIR = path.join(ROOT, "output");

// ---------------------------------------------------------------------------
// Target profiles
// ---------------------------------------------------------------------------
// NIC 2008 codes sit in the CIN (characters 2-6, e.g. U27202MH2019PTC123456).
// requireName: the NIC code alone isn't enough, the name/activity text must match.
const PROFILES = {
  // Charge point operators: companies that run charging stations / networks.
  cpo: {
    nic: {
      "3510": "Electric power",
      "4730": "Retail fuel",
      "5221": "Services incidental to land transport",
      "4520": "Vehicle maintenance & services",
    },
    words: [
      "ev charging", "e-charging", "echarging", "ev charge", "ev station",
      "ev stations", "charging station", "charging stations", "charging hub",
      "charging hubs", "charging point", "charging points", "charge point",
      "charge points", "chargepoint", "charging infra", "charging infrastructure",
      "charging network", "charging plaza", "evse", "electric vehicle charging",
      "e-vehicle charging", "ev recharge", "ev power station",
    ],
    exclude: ["manufactur"], // charger makers, unless they also run stations
    requireName: true,
  },
  // Wider EV list: CPOs + charger makers + e-mobility + fleets.
  ev: {
    nic: {
      "3510": "Electric power", "2790": "Other electrical equipment",
      "2710": "Electrical control apparatus", "2910": "Motor vehicles",
      "3091": "Two-wheelers", "4520": "Vehicle maintenance & services",
      "4730": "Retail fuel", "4921": "Urban passenger transport",
      "4923": "Freight by road", "5221": "Services incidental to land transport",
      "7710": "Vehicle rental / leasing", "6201": "Software development",
    },
    words: [
      "ev", "evs", "electric vehicle", "electric vehicles", "charging",
      "charger", "chargers", "charge point", "chargepoint", "e-mobility",
      "emobility", "e mobility", "electric mobility", "e-vehicle", "evse",
      "battery swapping", "e-bus", "ebus", "e-auto", "green mobility",
    ],
    requireName: true,
  },
  // Battery / BMS / EMS / solar companies.
  energy: {
    nic: {
      "2720": "Batteries & accumulators", "2710": "Electrical control apparatus",
      "2790": "Other electrical equipment", "2651": "Measuring / control instruments",
      "3510": "Electric power", "6201": "Software development",
      "6202": "IT consultancy / systems integration",
    },
    words: [
      "battery", "batteries", "energy storage", "bess", "lithium", "li-ion",
      "power electronics", "energy management", "bms", "solar", "renewable",
      "renewables", "smart grid", "microgrid", "inverter", "inverters",
      "cleantech",
    ],
    requireName: false,
  },
  // No filter: every record is kept. Handy as quick proof the API works.
  raw: { nic: {}, words: [], requireName: false, keepAll: true },
};

const FREE_MAIL = new Set([
  "gmail.com", "yahoo.com", "yahoo.co.in", "hotmail.com", "outlook.com",
  "rediffmail.com", "live.com", "icloud.com", "ymail.com", "protonmail.com",
]);

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const nowIST = () =>
  new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata", hour12: false });
// Shared live status, shown on the status page (see startStatusServer).
const STATUS = {
  startedAt: new Date().toISOString(),
  phase: "starting",
  current: null,
  logs: [],
};
const log = (...a) => {
  const line = `[${nowIST()}] ${a.join(" ")}`;
  console.log(line);
  STATUS.logs.push(line);
  if (STATUS.logs.length > 300) STATUS.logs.shift();
};

function loadEnvFile(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m || line.trim().startsWith("#")) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    if (process.env[m[1]] === undefined) process.env[m[1]] = v;
  }
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; }
}
function writeJson(file, data) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file); // atomic, so a crash never leaves a half-written file
}

// ---------------------------------------------------------------------------
// Config: .env first, command line overrides
// ---------------------------------------------------------------------------
// Bigger EV markets first, so the most useful results arrive early.
const ALL_STATES = [
  "MAHARASHTRA", "KARNATAKA", "DELHI", "TAMIL NADU", "TELANGANA", "GUJARAT",
  "UTTAR PRADESH", "KERALA", "HARYANA", "RAJASTHAN", "WEST BENGAL", "MADHYA PRADESH",
  "ANDHRA PRADESH", "PUNJAB", "ODISHA", "BIHAR", "CHHATTISGARH", "JHARKHAND",
  "UTTARAKHAND", "ASSAM", "GOA", "HIMACHAL PRADESH", "JAMMU AND KASHMIR",
  "CHANDIGARH", "PUDUCHERRY", "TRIPURA", "MEGHALAYA", "MANIPUR", "NAGALAND",
  "MIZORAM", "ARUNACHAL PRADESH", "SIKKIM", "LADAKH",
  "THE DADRA AND NAGAR HAVELI AND DAMAN AND DIU", "ANDAMAN AND NICOBAR ISLANDS",
  "LAKSHADWEEP",
];

function parseFilters(str) {
  const out = {};
  for (const part of (str || "").split(";")) {
    const eq = part.indexOf("=");
    if (eq > 0) out[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
  }
  return out;
}
const list = (s) => (s || "").split(",").map((x) => x.trim()).filter(Boolean);

function loadConfig(argv) {
  loadEnvFile(path.join(ROOT, ".env"));
  const env = process.env;
  const c = {
    key: env.DATA_GOV_KEY,
    resources: list(env.RESOURCE_IDS || env.RESOURCE_ID),
    profile: env.PROFILE || "cpo",
    filters: parseFilters(env.FILTERS),
    states: env.STATES === undefined ? "ALL" : env.STATES,
    stateField: env.STATE_FIELD || "State",
    districts: list(env.DISTRICTS),
    pageSize: parseInt(env.PAGE_SIZE || "1000", 10),
    delay: parseFloat(env.DELAY_SECONDS || "4") * 1000,
    maxPerDay: parseInt(env.MAX_REQUESTS_PER_DAY || "10000", 10),
    max: env.MAX_RECORDS ? parseInt(env.MAX_RECORDS, 10) : Infinity,
    allStatuses: env.ALL_STATUSES === "true",
    reset: false,
    sheetId: env.GOOGLE_SHEET_ID,
    webhookUrl: env.GOOGLE_WEBHOOK_URL,
    webhookSecret: env.GOOGLE_WEBHOOK_SECRET,
    sheetTab: env.GOOGLE_SHEET_TAB || "Leads",
    saFile: env.GOOGLE_SERVICE_ACCOUNT_FILE || "service-account.json",
  };
  if (env.STATE) c.states = env.STATE; // older .env files

  for (let i = 0; i < argv.length; i++) {
    const k = argv[i], v = argv[i + 1];
    const take = () => { i++; return v; };
    switch (k) {
      case "--key": c.key = take(); break;
      case "--resource": c.resources = list(take()); break;
      case "--profile": c.profile = take(); break;
      case "--state": case "--states": c.states = take(); break;
      case "--districts": c.districts = list(take()); break;
      case "--filter": Object.assign(c.filters, parseFilters(take())); break;
      case "--page-size": c.pageSize = parseInt(take(), 10); break;
      case "--delay": c.delay = parseFloat(take()) * 1000; break;
      case "--max": c.max = parseInt(take(), 10); break;
      case "--all-statuses": c.allStatuses = true; break;
      case "--reset": c.reset = true; break;
      case "--no-sheet": c.sheetId = ""; c.webhookUrl = ""; break;
      default: log(`Unknown option ${k} (ignored)`);
    }
  }
  // STATES: "ALL" = every state, "" or "NONE" = don't split by state, else a comma list.
  const s = String(c.states).trim().toUpperCase();
  c.stateList = s === "ALL" || s === "ALL_INDIA" ? ALL_STATES
    : s === "" || s === "NONE" ? [] : list(s);
  c.pageSize = Math.max(1, Math.min(1000, c.pageSize));
  c.delay = Math.max(2000, c.delay); // never faster than one request every 2 s
  if (!c.key) fatal("No API key. Set DATA_GOV_KEY in .env or pass --key.");
  if (!c.resources.length) fatal("No dataset. Set RESOURCE_IDS in .env or pass --resource.");
  if (!PROFILES[c.profile]) fatal(`PROFILE must be one of: ${Object.keys(PROFILES).join(", ")}`);
  return c;
}

// A config mistake: say so and exit. nodemon then waits for you to fix the file.
function fatal(msg) {
  console.error(`\nCONFIG ERROR: ${msg}\n`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// data.gov.in, politely
// ---------------------------------------------------------------------------
// One request at a time, at least `delay` apart (with a little random jitter).
// A rate-limit answer doubles the gap (up to 2 min) and adds a cool-down; the gap
// eases back towards the normal speed after a run of successful requests.
// A daily cap (IST calendar day) stops it from hammering the API around the clock.
class Throttle {
  constructor(c) {
    this.base = c.delay;
    this.gap = c.delay;
    this.maxPerDay = c.maxPerDay;
    this.file = path.join(STATE_DIR, "requests.json");
    this.day = readJson(this.file, { date: "", count: 0 });
    this.last = 0;
    this.okStreak = 0;
    this.avgResponseMs = 2000;
    this.restingUntil = null;
  }
  today() {
    return new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
  }
  async wait() {
    if (this.day.date !== this.today()) this.day = { date: this.today(), count: 0 };
    if (this.maxPerDay > 0 && this.day.count >= this.maxPerDay) {
      const now = new Date();
      const ist = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
      const msToMidnight = (24 * 3600 - (ist.getHours() * 3600 + ist.getMinutes() * 60 + ist.getSeconds())) * 1000;
      log(`Daily limit of ${this.maxPerDay} requests reached. Resting until after midnight IST ` +
        `(${Math.round(msToMidnight / 60000)} min).`);
      this.restingUntil = new Date(Date.now() + msToMidnight + 5 * 60 * 1000).toISOString();
      STATUS.phase = "resting (daily limit)";
      await sleep(msToMidnight + 5 * 60 * 1000);
      this.restingUntil = null;
      STATUS.phase = "scanning";
      this.day = { date: this.today(), count: 0 };
    }
    const jitter = this.gap * (0.8 + Math.random() * 0.4);
    const waitMs = this.last + jitter - Date.now();
    if (waitMs > 0) await sleep(waitMs);
    this.last = Date.now();
    this.day.count++;
    writeJson(this.file, this.day);
  }
  ok() {
    if (++this.okStreak >= 50 && this.gap > this.base) {
      this.gap = Math.max(this.base, Math.round(this.gap * 0.8));
      this.okStreak = 0;
      log(`  speeding back up: one request every ${(this.gap / 1000).toFixed(1)} s`);
    }
  }
  limited() {
    this.okStreak = 0;
    this.gap = Math.min(120000, this.gap * 2);
    log(`  slowing down: one request every ${(this.gap / 1000).toFixed(1)} s`);
  }
}

class SkipResource extends Error {}

// Never gives up on network trouble or rate limits: it waits longer and longer
// (up to 30 minutes) and tries again, so the process keeps running unattended.
// A dataset that doesn't exist (400/404) is skipped instead.
async function fetchPage(c, throttle, resource, offset, limit, filters) {
  const url = new URL(`https://api.data.gov.in/resource/${resource}`);
  url.searchParams.set("api-key", c.key);
  url.searchParams.set("format", "json");
  url.searchParams.set("offset", offset);
  url.searchParams.set("limit", limit);
  for (const [f, val] of Object.entries(filters)) url.searchParams.set(`filters[${f}]`, val);

  let oddReplies = 0;
  for (let attempt = 0; ; attempt++) {
    let wait = Math.min(30 * 60, 60 * 2 ** attempt) * 1000;
    await throttle.wait();
    try {
      const t0 = Date.now();
      const res = await fetch(url, { signal: AbortSignal.timeout(90000) });
      const text = await res.text();
      throttle.avgResponseMs = throttle.avgResponseMs * 0.9 + (Date.now() - t0) * 0.1;
      let data = null;
      try { data = JSON.parse(text); } catch { /* not JSON */ }
      if (res.ok && data && Array.isArray(data.records)) {
        throttle.ok();
        return data;
      }
      const msg = (data && (data.message || data.error)) || text.slice(0, 200).replace(/\s+/g, " ");
      if (res.status === 400 || res.status === 404) {
        throw new SkipResource(`dataset ${resource} answered ${res.status}: ${msg}`);
      }
      if (res.ok && ++oddReplies >= 5) {
        throw new SkipResource(`dataset ${resource} keeps answering without records: ${msg}`);
      }
      const retryAfter = parseInt(res.headers.get("retry-after") || "0", 10);
      if (retryAfter) wait = Math.max(wait, retryAfter * 1000);
      if (res.status === 429 || /rate|limit|too many/i.test(msg)) throttle.limited();
      if (res.status === 403) {
        wait = 30 * 60 * 1000;
        log(`403 Forbidden (${msg}). Check DATA_GOV_KEY. Trying again in 30 min.`);
      } else {
        log(`HTTP ${res.status} (${msg}). Waiting ${Math.round(wait / 1000)} s before retrying.`);
      }
    } catch (e) {
      if (e instanceof SkipResource) throw e;
      log(`Network error (${e.message}). Waiting ${Math.round(wait / 1000)} s before retrying.`);
    }
    await sleep(wait);
  }
}

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------
function findField(rec, ...candidates) {
  const keys = Object.keys(rec);
  for (const cand of candidates) {
    const k = keys.find((key) => key.toLowerCase().includes(cand));
    if (k !== undefined && rec[k] != null && rec[k] !== "") return String(rec[k]);
  }
  return "";
}

function wordRegex(w) {
  const esc = w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![a-z0-9])${esc}(?![a-z0-9])`, "i");
}

// MSME "Activities" is a JSON list of {NIC5DigitId, Description}; make it readable.
function activityText(rec) {
  const raw = findField(rec, "activit", "principal_business", "description", "nature");
  try {
    const list = JSON.parse(raw);
    if (Array.isArray(list)) {
      return list.map((a) => a.Description || a.description || Object.values(a).join(" ")).join("; ");
    }
  } catch { /* not JSON, use as is */ }
  return raw;
}

const companyName = (rec) => findField(rec, "company_name", "companyname", "enterprisename", "name");

function classify(rec, profile, wordRes) {
  if (profile.keepAll) return ["raw (unfiltered)"];
  const nicHits = [];
  const cin = findField(rec, "corporate_identification", "cin").trim().toUpperCase();
  if (/^[LU]\d{5}/.test(cin)) {
    const nic = cin.slice(1, 6);
    for (const [p, label] of Object.entries(profile.nic)) {
      if (nic.startsWith(p)) nicHits.push(`NIC ${nic}: ${label}`);
    }
  }
  const text = `${companyName(rec)} ${activityText(rec)}`;
  const nameHits = profile.words.filter((w, i) => wordRes[i].test(text));
  if (profile.requireName && !nameHits.length) return [];
  const lower = text.toLowerCase();
  if ((profile.exclude || []).some((x) => lower.includes(x)) &&
      !/station|hub|network|operat|plaza/.test(lower)) return [];
  const reasons = [...nicHits];
  if (nameHits.length) reasons.push(`matched: ${nameHits.join(", ")}`);
  return reasons;
}

// ---------------------------------------------------------------------------
// Leads: one tidy row per lead, used for the Sheet and the CSVs
// ---------------------------------------------------------------------------
const LEAD_COLUMNS = [
  "Found at (IST)", "Company", "Activity", "District", "State", "Pincode",
  "Registration date", "Address", "CIN", "Email", "Why matched", "Source dataset",
  "Outreach status", "Owner", "Notes",
];

function toLead(rec, reasons, resource) {
  return {
    "Found at (IST)": nowIST(),
    Company: companyName(rec),
    Activity: activityText(rec).slice(0, 500),
    District: findField(rec, "district"),
    State: findField(rec, "registered_state", "companystatecode", "state"),
    Pincode: findField(rec, "pincode", "pin_code"),
    "Registration date": findField(rec, "registrationdate", "date_of_registration", "registration_date", "incorporation"),
    Address: findField(rec, "address").slice(0, 300),
    CIN: findField(rec, "corporate_identification", "cin"),
    Email: findField(rec, "email"),
    "Why matched": reasons.join(" | "),
    "Source dataset": resource,
    "Outreach status": "Not contacted",
    Owner: "",
    Notes: "",
  };
}

const leadKey = (l) =>
  (l.CIN || `${l.Company}|${l.Pincode}`).toLowerCase().replace(/\s+/g, " ").trim();

// ---------------------------------------------------------------------------
// CSV output
// ---------------------------------------------------------------------------
function csvCell(v) {
  let s = v == null ? "" : String(v);
  if (/^[=+\-@]/.test(s)) s = `'${s}`; // stop spreadsheets treating text as a formula
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
function writeCsv(file, cols, rows) {
  const lines = [cols.map(csvCell).join(",")];
  for (const r of rows) lines.push(cols.map((c) => csvCell(r[c])).join(","));
  fs.writeFileSync(file, "﻿" + lines.join("\r\n"), "utf8");
}

const LEGAL_SUFFIX =
  /\b(private limited|pvt\.? ltd\.?|pvt limited|private ltd\.?|limited|ltd\.?|llp|\(opc\)|opc|india)\s*$/i;
function cleanName(name) {
  let n = String(name).replace(/\s+/g, " ").trim();
  for (let i = 0; i < 3; i++) {
    const n2 = n.replace(LEGAL_SUFFIX, "").replace(/[\s,.-]+$/, "").trim();
    if (n2 === n) break;
    n = n2;
  }
  return n === n.toUpperCase() ? n.toLowerCase().replace(/\b\w/g, (ch) => ch.toUpperCase()) : n;
}

function writeOutputs(profileName, leads) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  writeCsv(path.join(OUT_DIR, `${profileName}_leads.csv`), LEAD_COLUMNS, leads);

  // LinkedIn Matched Audiences company list (check headers against LinkedIn's template).
  const cols = ["companyname", "companywebsite", "companyemaildomain",
    "linkedincompanypageurl", "city", "state", "companycountry"];
  const seen = new Set();
  const rows = [];
  for (const l of leads) {
    const name = cleanName(l.Company);
    if (!name || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    const email = (l.Email || "").toLowerCase();
    const dom = email.includes("@") ? email.split("@")[1] : "";
    const site = FREE_MAIL.has(dom) ? "" : dom;
    rows.push({
      companyname: name, companywebsite: site, companyemaildomain: site,
      linkedincompanypageurl: "", city: l.District, state: l.State, companycountry: "India",
    });
  }
  writeCsv(path.join(OUT_DIR, `${profileName}_linkedin_upload.csv`), cols, rows);
}

// ---------------------------------------------------------------------------
// Google Sheets (service account, no npm packages)
// ---------------------------------------------------------------------------
class Sheet {
  constructor(c) {
    this.id = c.sheetId;
    this.tab = c.sheetTab;
    this.saPath = path.isAbsolute(c.saFile) ? c.saFile : path.join(ROOT, c.saFile);
    this.enabled = Boolean(this.id);
    this.token = null;
    this.tokenExp = 0;
  }

  async getToken() {
    if (this.token && Date.now() < this.tokenExp - 60000) return this.token;
    const sa = JSON.parse(fs.readFileSync(this.saPath, "utf8"));
    const now = Math.floor(Date.now() / 1000);
    const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
    const unsigned = `${b64({ alg: "RS256", typ: "JWT" })}.${b64({
      iss: sa.client_email,
      scope: "https://www.googleapis.com/auth/spreadsheets",
      aud: "https://oauth2.googleapis.com/token",
      iat: now,
      exp: now + 3600,
    })}`;
    const sig = crypto.sign("RSA-SHA256", Buffer.from(unsigned), sa.private_key).toString("base64url");
    const res = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion: `${unsigned}.${sig}`,
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(`Google token error: ${JSON.stringify(data).slice(0, 300)}`);
    this.token = data.access_token;
    this.tokenExp = Date.now() + data.expires_in * 1000;
    return this.token;
  }

  async call(method, range, query, body) {
    const url = `https://sheets.googleapis.com/v4/spreadsheets/${this.id}/values/` +
      `${encodeURIComponent(range)}${query}`;
    const res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${await this.getToken()}`,
        "Content-Type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`Sheets ${res.status}: ${JSON.stringify(data).slice(0, 300)}`);
    return data;
  }

  // Writes the header row if the tab's first row is empty.
  async ensureHeader() {
    if (!this.enabled) return;
    const got = await this.call("GET", `${this.tab}!A1:O1`, "");
    if (!got.values || !got.values.length) {
      await this.call("PUT", `${this.tab}!A1`, "?valueInputOption=RAW", { values: [LEAD_COLUMNS] });
      log(`Wrote header row to Google Sheet tab "${this.tab}".`);
    }
  }

  async append(leads) {
    if (!this.enabled || !leads.length) return;
    const values = leads.map((l) => LEAD_COLUMNS.map((col) => (l[col] == null ? "" : String(l[col]))));
    // RAW: text goes in exactly as written, never interpreted as a formula.
    await this.call("POST", `${this.tab}!A1`,
      ":append?valueInputOption=RAW&insertDataOption=INSERT_ROWS", { values });
  }
}


// Same job through a Google Apps Script web app (see apps-script.gs). Needs no
// Google Cloud keys: the script runs as the sheet's owner and checks a secret.
class WebhookSheet {
  constructor(c) {
    this.url = c.webhookUrl;
    this.secret = c.webhookSecret || "";
    this.tab = "Leads";
    this.enabled = Boolean(this.url);
    this.saPath = null;
  }

  async post(rows) {
    const res = await fetch(this.url, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify({ secret: this.secret, header: LEAD_COLUMNS, rows }),
      redirect: "follow",
      signal: AbortSignal.timeout(60000),
    });
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch {
      throw new Error(`webhook answered ${res.status} with non-JSON (is it deployed with access "Anyone"?): ${text.slice(0, 150).replace(/\s+/g, " ")}`);
    }
    if (!data.ok) throw new Error(`webhook refused: ${data.error}`);
    return data;
  }

  async ensureHeader() {
    if (this.enabled) await this.post([]); // writes the header row if the tab is empty
  }

  async append(leads) {
    if (!this.enabled || !leads.length) return;
    await this.post(leads.map((l) => LEAD_COLUMNS.map((col) => (l[col] == null ? "" : String(l[col])))));
  }
}

// ---------------------------------------------------------------------------
// Backups: one copy of the leads file per day in state/backups (last 30 kept),
// so even a deleted or damaged leads file can be restored.
// ---------------------------------------------------------------------------
function backupLeads(profileName, leadsFile) {
  try {
    const dir = path.join(STATE_DIR, "backups");
    fs.mkdirSync(dir, { recursive: true });
    const day = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
    fs.copyFileSync(leadsFile, path.join(dir, `${profileName}_leads_${day}.json`));
    const old = fs.readdirSync(dir).filter((f) => f.startsWith(`${profileName}_leads_`)).sort();
    for (const f of old.slice(0, -30)) fs.unlinkSync(path.join(dir, f));
  } catch (e) {
    log(`Backup failed (${e.message}); the main leads file is unaffected.`);
  }
}

// ---------------------------------------------------------------------------
// Planning: which jobs to run for each dataset
// ---------------------------------------------------------------------------
const jobKey = (c, resource, filters) => {
  const f = Object.entries(filters).sort().map(([k, v]) => `${k}=${v}`).join("&");
  return `${resource}|${c.profile}|${f}`;
};

// Asks the dataset (with tiny 1-record requests) how many records it has, overall
// and per state, and saves the answer so restarts don't ask again. If the state
// names don't cover (almost) the whole dataset, it scans the dataset in one go
// instead, so no state is silently missed.
async function planJobs(c, throttle, resource) {
  const planFile = path.join(STATE_DIR, `plan_${resource}.json`);
  const key = JSON.stringify({ states: c.stateList, districts: c.districts, filters: c.filters, f: c.stateField });
  const cached = readJson(planFile, null);
  if (cached && cached.key === key && !c.reset) return cached.jobs;

  const probe = await fetchPage(c, throttle, resource, 0, 1, c.filters);
  const fields = (probe.field || []).map((f) => f.id);
  const total = Number(probe.total) || 0;
  log(`Dataset ${resource}: ${total.toLocaleString("en-IN")} records. Fields: ${fields.join(", ")}`);

  let jobs = [{ ...c.filters }];
  let jobTotals = [total];
  if (c.stateList.length && fields.includes(c.stateField)) {
    log(`  Checking ${c.stateList.length} state names against the dataset...`);
    const perState = [];
    let covered = 0;
    for (const st of c.stateList) {
      const d = await fetchPage(c, throttle, resource, 0, 1, { ...c.filters, [c.stateField]: st });
      const n = Number(d.total) || 0;
      covered += n;
      perState.push({ st, n });
      log(`    ${st}: ${n.toLocaleString("en-IN")}`);
    }
    const missing = perState.filter((p) => !p.n).map((p) => p.st);
    const share = total ? covered / total : 0;
    log(`  State names cover ${(share * 100).toFixed(2)}% of the dataset.` +
      (missing.length ? ` No records for: ${missing.join(", ")}.` : ""));
    if (c.filters[c.stateField] === undefined && share < 0.98 && c.stateList === ALL_STATES) {
      log("  Some records use other state spellings, so the whole dataset will be scanned in one pass instead.");
    } else {
      jobs = [];
      jobTotals = [];
      for (const { st, n } of perState.filter((p) => p.n)) {
        if (c.districts.length) {
          for (const d of c.districts) {
            jobs.push({ ...c.filters, [c.stateField]: st, District: d });
            jobTotals.push(null); // district counts aren't known until scanned
          }
        } else {
          jobs.push({ ...c.filters, [c.stateField]: st });
          jobTotals.push(n);
        }
      }
    }
  } else if (c.stateList.length) {
    log(`  This dataset has no "${c.stateField}" field, so it is scanned in one pass (all of India).`);
  }
  writeJson(planFile, { key, total, jobs, jobTotals, profile: c.profile });
  return jobs;
}

// ---------------------------------------------------------------------------
// Live status page (built in, no packages)
// ---------------------------------------------------------------------------
// Started when STATUS_PORT is set. Password-protected with STATUS_PASSWORD
// (browser login box, user name STATUS_USER, default "admin").
//   /               the page (refreshes itself every 15 s)
//   /api/status     progress as JSON
//   /api/leads?from=N  leads from number N on
//   /leads.csv, /linkedin.csv  downloads
function buildStatus() {
  const c = STATUS.config;
  const t = STATUS.throttle;
  const progress = readJson(path.join(STATE_DIR, "progress.json"), {});
  const datasets = [];
  for (const resource of c.resources) {
    const plan = readJson(path.join(STATE_DIR, `plan_${resource}.json`), null);
    if (!plan) { datasets.push({ resource, planned: false, jobs: [] }); continue; }
    const jobs = plan.jobs.map((filters, i) => {
      const key = jobKey(c, resource, filters);
      const p = progress[key] || {};
      const total = p.total ?? (plan.jobTotals ? plan.jobTotals[i] : null);
      return {
        label: Object.keys(filters).length ? Object.values(filters).join(" / ") : "All of India",
        offset: p.offset || 0,
        total,
        done: Boolean(p.done),
        updated: p.updated || "",
      };
    });
    const total = jobs.reduce((a, j) => a + (j.total || 0), 0) || plan.total || 0;
    const scanned = jobs.reduce((a, j) => a + (j.done ? (j.total || j.offset) : j.offset), 0);
    datasets.push({ resource, planned: true, total, scanned, jobs });
  }
  const remaining = datasets.reduce((a, d) => a + Math.max(0, (d.total || 0) - (d.scanned || 0)), 0);
  const perRequestS = (t.gap + t.avgResponseMs) / 1000;
  const requestsLeft = Math.ceil(remaining / c.pageSize);
  // Respect the daily cap when estimating.
  const perDay = c.maxPerDay > 0 ? Math.min(c.maxPerDay, 86400 / perRequestS) : 86400 / perRequestS;
  const etaHours = (requestsLeft / perDay) * 24;
  return {
    now: nowIST(),
    startedAt: STATUS.startedAt,
    phase: STATUS.phase,
    profile: c.profile,
    current: STATUS.current,
    leads: STATUS.leads.length,
    pendingSheet: readJson(path.join(STATE_DIR, "sheet_pending.json"), []).length,
    requestsToday: t.day.count,
    maxPerDay: c.maxPerDay,
    secondsBetweenRequests: +(t.gap / 1000).toFixed(1),
    avgResponseSeconds: +(t.avgResponseMs / 1000).toFixed(1),
    restingUntil: t.restingUntil,
    etaHours: +etaHours.toFixed(1),
    etaIncomplete: datasets.some((d) => !d.planned), // some datasets not sized yet
    datasets,
    logs: STATUS.logs.slice(-40),
  };
}

const STATUS_PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Leads bot status</title>
<style>
  :root { --bg:#f6f7f9; --card:#fff; --ink:#1d2433; --muted:#667085; --line:#e4e7ec; --acc:#2f6fed; --ok:#12a150; }
  @media (prefers-color-scheme: dark) { :root { --bg:#0f1218; --card:#171b23; --ink:#e7eaf0; --muted:#98a2b3; --line:#2a303b; --acc:#6b9cff; --ok:#35c46f; } }
  * { box-sizing: border-box; }
  body { margin:0; font:14px/1.45 system-ui,-apple-system,Segoe UI,Roboto,sans-serif; background:var(--bg); color:var(--ink); }
  main { max-width:1200px; margin:0 auto; padding:20px; }
  h1 { font-size:20px; margin:0 0 4px; } h2 { font-size:15px; margin:0 0 10px; }
  .muted { color:var(--muted); }
  .grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(170px,1fr)); gap:12px; margin:16px 0; }
  .card { background:var(--card); border:1px solid var(--line); border-radius:10px; padding:14px; }
  .big { font-size:24px; font-weight:650; }
  .bar { height:8px; background:var(--line); border-radius:4px; overflow:hidden; }
  .bar > span { display:block; height:100%; background:var(--acc); }
  .bar.done > span { background:var(--ok); }
  table { width:100%; border-collapse:collapse; }
  th, td { text-align:left; padding:6px 8px; border-bottom:1px solid var(--line); vertical-align:top; }
  th { font-weight:600; color:var(--muted); font-size:12px; }
  td.num { text-align:right; font-variant-numeric:tabular-nums; white-space:nowrap; }
  .section { margin-top:16px; }
  .toolbar { display:flex; gap:8px; align-items:center; flex-wrap:wrap; margin-bottom:10px; }
  input[type=search] { flex:1; min-width:200px; padding:7px 10px; border:1px solid var(--line); border-radius:8px; background:var(--card); color:var(--ink); }
  a.btn { padding:7px 12px; border:1px solid var(--line); border-radius:8px; text-decoration:none; color:var(--ink); background:var(--card); }
  .scroll { max-height:520px; overflow:auto; }
  pre { margin:0; font:12px/1.4 ui-monospace,Consolas,monospace; white-space:pre-wrap; max-height:260px; overflow:auto; }
  .pill { display:inline-block; padding:2px 8px; border-radius:999px; background:var(--line); font-size:12px; }
</style></head>
<body><main>
  <h1>Leads bot</h1>
  <div class="muted" id="sub">Loading…</div>

  <div class="grid">
    <div class="card"><div class="muted">Leads found</div><div class="big" id="k-leads">–</div></div>
    <div class="card"><div class="muted">Scanned overall</div><div class="big" id="k-pct">–</div><div class="bar"><span id="k-bar" style="width:0"></span></div><div class="muted" id="k-pct-note"></div></div>
    <div class="card"><div class="muted">Time left (est.)</div><div class="big" id="k-eta">–</div></div>
    <div class="card"><div class="muted">Requests today</div><div class="big" id="k-req">–</div><div class="muted" id="k-pace"></div></div>
  </div>

  <div class="card section"><h2>Now</h2><div id="now">–</div></div>

  <div class="card section"><h2>Progress by dataset</h2><div id="datasets"></div></div>

  <div class="card section">
    <h2>Leads <span class="muted" id="lead-count"></span></h2>
    <div class="toolbar">
      <input type="search" id="q" placeholder="Filter by name, district, state…">
      <a class="btn" href="leads.csv">Download CSV</a>
      <a class="btn" href="linkedin.csv">LinkedIn upload CSV</a>
    </div>
    <div class="scroll"><table>
      <thead><tr><th>Found</th><th>Company</th><th>District</th><th>State</th><th>Pincode</th><th>Activity</th><th>Why matched</th></tr></thead>
      <tbody id="leads"></tbody>
    </table></div>
  </div>

  <div class="card section"><h2>Recent log</h2><pre id="log"></pre></div>
</main>
<script>
const fmt = (n) => n == null ? "?" : Number(n).toLocaleString("en-IN");
const el = (tag, text, cls) => { const e = document.createElement(tag); if (text != null) e.textContent = text; if (cls) e.className = cls; return e; };
const leads = [];

function bar(pct, done) {
  const b = el("div", null, "bar" + (done ? " done" : ""));
  const s = el("span"); s.style.width = Math.min(100, pct).toFixed(2) + "%"; b.append(s); return b;
}

function renderLeads() {
  const q = document.getElementById("q").value.trim().toLowerCase();
  const body = document.getElementById("leads");
  body.replaceChildren();
  const shown = leads.filter((l) => !q || Object.values(l).join(" ").toLowerCase().includes(q)).slice().reverse();
  for (const l of shown.slice(0, 2000)) {
    const tr = el("tr");
    for (const k of ["Found at (IST)", "Company", "District", "State", "Pincode", "Activity", "Why matched"]) tr.append(el("td", l[k] || ""));
    body.append(tr);
  }
  document.getElementById("lead-count").textContent =
    "(" + fmt(shown.length) + (q ? " matching" : "") + (shown.length > 2000 ? ", newest 2,000 shown" : "") + ")";
}

async function refresh() {
  try {
    const s = await (await fetch("api/status", { cache: "no-store" })).json();
    document.getElementById("sub").textContent =
      "Profile " + s.profile + " · " + s.phase + " · updated " + s.now + (s.pendingSheet ? " · " + s.pendingSheet + " waiting for Google Sheet" : "");
    document.getElementById("k-leads").textContent = fmt(s.leads);
    const total = s.datasets.reduce((a, d) => a + (d.total || 0), 0);
    const scanned = s.datasets.reduce((a, d) => a + (d.scanned || 0), 0);
    const pct = total ? (scanned / total) * 100 : 0;
    document.getElementById("k-pct").textContent = pct.toFixed(1) + "%";
    document.getElementById("k-bar").style.width = pct.toFixed(2) + "%";
    document.getElementById("k-pct-note").textContent = s.etaIncomplete ? "of datasets sized so far" : fmt(scanned) + " of " + fmt(total) + " records";
    document.getElementById("k-eta").textContent = s.phase === "done" ? "Done" : s.etaHours < 48 ? s.etaHours.toFixed(1) + " h" : (s.etaHours / 24).toFixed(1) + " days";
    if (s.etaIncomplete && s.phase !== "done") document.getElementById("k-eta").textContent += " +";
    document.getElementById("k-req").textContent = fmt(s.requestsToday) + (s.maxPerDay ? " / " + fmt(s.maxPerDay) : "");
    document.getElementById("k-pace").textContent = "1 request every " + s.secondsBetweenRequests + " s, replies in ~" + s.avgResponseSeconds + " s" +
      (s.restingUntil ? " · resting until " + new Date(s.restingUntil).toLocaleString("en-IN") : "");

    const now = document.getElementById("now");
    now.replaceChildren();
    if (s.current) {
      const c = s.current, p = c.total ? (c.offset / c.total) * 100 : 0;
      now.append(el("div", c.label + " (" + c.resource.slice(0, 8) + "…): " + fmt(c.offset) + " of " + fmt(c.total) + " records"), bar(p));
    } else now.append(el("div", s.phase === "done" ? "All datasets finished." : s.phase === "planning" ? "Checking how many records each state has…" : s.phase, "muted"));

    const ds = document.getElementById("datasets");
    ds.replaceChildren();
    for (const d of s.datasets) {
      const box = el("div"); box.style.marginBottom = "18px";
      const head = el("div"); head.append(el("b", d.resource), " ");
      if (!d.planned) { head.append(el("span", "not started yet", "pill")); box.append(head); ds.append(box); continue; }
      const p = d.total ? (d.scanned / d.total) * 100 : 0;
      head.append(el("span", fmt(d.scanned) + " of " + fmt(d.total) + " (" + p.toFixed(1) + "%)", "muted"));
      box.append(head, bar(p, p >= 100));
      const t = el("table"); t.style.marginTop = "8px";
      const hr = el("tr"); for (const h of ["Part", "Scanned", "Total", "%", "Status"]) hr.append(el("th", h)); t.append(hr);
      for (const j of d.jobs) {
        const tr = el("tr");
        const jp = j.total ? (j.offset / j.total) * 100 : 0;
        tr.append(el("td", j.label), el("td", fmt(j.offset), "num"), el("td", fmt(j.total), "num"),
          el("td", j.done ? "100%" : jp.toFixed(1) + "%", "num"),
          el("td", j.done ? "done" : j.offset ? "in progress" : "waiting"));
        t.append(tr);
      }
      box.append(t); ds.append(box);
    }
    document.getElementById("log").textContent = s.logs.join("\\n");

    const more = await (await fetch("api/leads?from=" + leads.length, { cache: "no-store" })).json();
    if (more.reset) leads.length = 0;
    leads.push(...more.leads);
    renderLeads();
  } catch (e) {
    document.getElementById("sub").textContent = "Can't reach the bot (" + e.message + "). Retrying…";
  }
}
document.getElementById("q").addEventListener("input", renderLeads);
refresh(); setInterval(refresh, 15000);
</script></body></html>`;

function startStatusServer(c) {
  const port = parseInt(process.env.STATUS_PORT || "0", 10);
  if (!port) return;
  const password = process.env.STATUS_PASSWORD || "";
  const user = process.env.STATUS_USER || "admin";
  if (!password) {
    log("STATUS_PORT is set but STATUS_PASSWORD is empty: status page NOT started (it shows lead data).");
    return;
  }
  const http = require("http");
  const expected = Buffer.from("Basic " + Buffer.from(`${user}:${password}`).toString("base64"));
  const authorised = (req) => {
    const got = Buffer.from(req.headers.authorization || "");
    return got.length === expected.length && crypto.timingSafeEqual(got, expected);
  };
  const send = (res, code, type, body, extra = {}) => {
    res.writeHead(code, { "Content-Type": type, "Cache-Control": "no-store", "X-Frame-Options": "DENY", ...extra });
    res.end(body);
  };

  const server = http.createServer((req, res) => {
    if (!authorised(req)) {
      return send(res, 401, "text/plain", "Login required", { "WWW-Authenticate": 'Basic realm="Leads bot", charset="UTF-8"' });
    }
    const url = new URL(req.url, "http://x");
    try {
      if (url.pathname === "/") return send(res, 200, "text/html; charset=utf-8", STATUS_PAGE);
      if (url.pathname === "/api/status") return send(res, 200, "application/json", JSON.stringify(buildStatus()));
      if (url.pathname === "/api/leads") {
        const from = Math.max(0, parseInt(url.searchParams.get("from") || "0", 10));
        const all = STATUS.leads;
        const reset = from > all.length; // e.g. after --reset
        return send(res, 200, "application/json", JSON.stringify({ reset, leads: all.slice(reset ? 0 : from) }));
      }
      const files = { "/leads.csv": `${c.profile}_leads.csv`, "/linkedin.csv": `${c.profile}_linkedin_upload.csv` };
      if (files[url.pathname]) {
        const f = path.join(OUT_DIR, files[url.pathname]);
        if (!fs.existsSync(f)) return send(res, 404, "text/plain", "No leads yet");
        return send(res, 200, "text/csv; charset=utf-8", fs.readFileSync(f),
          { "Content-Disposition": `attachment; filename="${files[url.pathname]}"` });
      }
      send(res, 404, "text/plain", "Not found");
    } catch (e) {
      send(res, 500, "text/plain", "Error: " + e.message);
    }
  });
  server.on("error", (e) => log(`Status page could not start on port ${port}: ${e.message}`));
  server.listen(port, "0.0.0.0", () => log(`Status page on port ${port} (login: ${user} / STATUS_PASSWORD).`));
  STATUS.server = server;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const c = loadConfig(process.argv.slice(2));
  const profile = PROFILES[c.profile];
  const wordRes = profile.words.map(wordRegex);
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const throttle = new Throttle(c);

  const progressFile = path.join(STATE_DIR, "progress.json");
  const leadsFile = path.join(STATE_DIR, `${c.profile}_leads.json`);
  const pendingFile = path.join(STATE_DIR, "sheet_pending.json");
  const progress = readJson(progressFile, {});
  const leads = readJson(leadsFile, []);
  let pending = readJson(pendingFile, []);
  const seen = new Set(leads.map(leadKey));
  STATUS.config = c;
  STATUS.throttle = throttle;
  STATUS.leads = leads;
  startStatusServer(c);

  log(`Profile "${c.profile}", datasets: ${c.resources.join(", ")}`);
  log(`Pace: one request every ~${(c.delay / 1000).toFixed(1)} s, at most ` +
    `${c.maxPerDay > 0 ? c.maxPerDay.toLocaleString("en-IN") : "unlimited"} requests per day.`);

  const sheet = c.webhookUrl ? new WebhookSheet(c) : new Sheet(c);
  if (c.webhookUrl && !c.webhookSecret) fatal("GOOGLE_WEBHOOK_URL is set but GOOGLE_WEBHOOK_SECRET is empty.");
  if (sheet.enabled) {
    if (sheet.saPath && !fs.existsSync(sheet.saPath)) fatal(`Service account file not found: ${sheet.saPath}`);
    try {
      await sheet.ensureHeader();
      log(`Google Sheet connected${c.webhookUrl ? " via Apps Script" : ""} (tab "${sheet.tab}").`);
    } catch (e) {
      log(`Google Sheet not reachable yet: ${e.message}`);
      log("Leads are still saved locally and will be sent once the sheet works.");
    }
  } else {
    log("No Google Sheet set: leads are saved to ./output only.");
  }

  const flushSheet = async () => {
    if (!sheet.enabled || !pending.length) return;
    try {
      // Sheets accepts large batches; send at most 500 rows per call.
      while (pending.length) {
        const batch = pending.slice(0, 500);
        await sheet.append(batch);
        pending = pending.slice(batch.length);
        log(`Added ${batch.length} lead(s) to Google Sheet.`);
      }
    } catch (e) {
      log(`Could not write to Google Sheet (${e.message}); will retry with the next batch.`);
    }
    writeJson(pendingFile, pending);
  };

  for (const resource of c.resources) {
    let jobs;
    STATUS.phase = "planning";
    STATUS.current = null;
    try {
      jobs = await planJobs(c, throttle, resource);
    } catch (e) {
      if (e instanceof SkipResource) { log(`Skipping: ${e.message}`); continue; }
      throw e;
    }
    log(`Dataset ${resource}: ${jobs.length} job(s) planned.`);

    for (const filters of jobs) {
      const key = jobKey(c, resource, filters);
      if (c.reset) delete progress[key];
      const saved = progress[key] || { offset: 0, done: false };
      if (saved.done) { log(`Already finished: ${JSON.stringify(filters)}.`); continue; }
      let offset = saved.offset || 0;
      const end = c.max === Infinity ? Infinity : offset + c.max;
      const label = Object.keys(filters).length ? JSON.stringify(filters) : "all of India";
      log(`Job ${label}: starting at record ${offset.toLocaleString("en-IN")}.`);

      let total = null;
      STATUS.phase = "scanning";
      STATUS.current = { resource, label, offset, total: null };
      try {
        while (offset < end) {
          const limit = Math.min(c.pageSize, end - offset);
          const data = await fetchPage(c, throttle, resource, offset, limit, filters);
          if (total === null) total = Number(data.total) || 0;
          STATUS.current.total = total;
          const records = data.records || [];
          if (!records.length) break;

          const fresh = [];
          for (const rec of records) {
            const status = findField(rec, "company_status", "companystatus").toLowerCase();
            if (!c.allStatuses && status && !status.includes("active")) continue;
            const reasons = classify(rec, profile, wordRes);
            if (!reasons.length) continue;
            const lead = toLead(rec, reasons, resource);
            const k = leadKey(lead);
            if (seen.has(k)) continue;
            seen.add(k);
            fresh.push(lead);
          }

          offset += records.length;
          if (fresh.length) {
            leads.push(...fresh);
            if (sheet.enabled) pending.push(...fresh);
            writeJson(leadsFile, leads);
            backupLeads(c.profile, leadsFile);
            writeJson(pendingFile, pending);
            writeOutputs(c.profile, leads);
            for (const l of fresh) {
              log(`  NEW LEAD: ${l.Company} (${[l.District, l.State].filter(Boolean).join(", ") || "?"}) ${l["Why matched"]}`);
            }
            await flushSheet();
          }
          progress[key] = { offset, done: false, total, updated: nowIST() };
          writeJson(progressFile, progress);
          STATUS.current.offset = offset;

          const pct = total ? ((offset / total) * 100).toFixed(2) : "?";
          const pagesLeft = total ? Math.ceil((total - offset) / c.pageSize) : 0;
          const hoursLeft = (pagesLeft * (throttle.gap / 1000 + 2)) / 3600;
          log(`  ${label}: ${offset.toLocaleString("en-IN")} of ${total.toLocaleString("en-IN")} (${pct}%), ` +
            `leads so far ${leads.length}, ~${hoursLeft.toFixed(1)} h left in this job`);
        }
      } catch (e) {
        if (e instanceof SkipResource) { log(`Skipping rest of dataset: ${e.message}`); break; }
        throw e;
      }

      const finished = c.max === Infinity;
      progress[key] = { offset, done: finished, total, updated: nowIST() };
      writeJson(progressFile, progress);
      log(finished ? `Finished ${label}.` : `Stopped at --max for ${label}.`);
    }
  }

  await flushSheet();
  writeOutputs(c.profile, leads);
  log(`All jobs done. ${leads.length} lead(s) in output/${c.profile}_leads.csv` +
    (pending.length ? `, ${pending.length} still waiting to be sent to the sheet.` : "."));
  STATUS.phase = "done";
  STATUS.current = null;
  if (STATUS.server) log("Status page keeps running. Stop with Ctrl+C.");
}

process.on("SIGINT", () => { log("Stopped (progress is saved)."); process.exit(0); });
process.on("SIGTERM", () => { log("Stopped (progress is saved)."); process.exit(0); });

if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}

module.exports = { PROFILES, classify, wordRegex, toLead, leadKey, cleanName, parseFilters, Sheet, WebhookSheet, ALL_STATES };
