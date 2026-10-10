import { createRequire as __cr } from "node:module"; const require = __cr(import.meta.url);

// src/db/memory.ts
import { randomUUID } from "node:crypto";

// src/db/repository.ts
var emptyCall = (c) => ({
  providerCallId: null,
  endedAt: null,
  durationSec: null,
  answerLatencyMs: null,
  afterHours: false,
  callerPhone: null,
  callerName: null,
  transcript: [],
  facts: null,
  checks: null,
  verdict: "in_progress",
  reasons: [],
  flags: [],
  pricingAsked: false,
  handoffStatus: "not_applicable",
  handoffSentAt: null,
  bookingStatus: "not_applicable",
  bookingTime: null,
  bookingRef: null,
  crmStatus: "not_applicable",
  crmDealId: null,
  auditIssues: null,
  sessionState: null,
  ...c
});

// src/db/memory.ts
var MemoryRepository = class {
  calls = /* @__PURE__ */ new Map();
  costs = [];
  fixed = [];
  events = /* @__PURE__ */ new Map();
  async createCall(c) {
    if (c.providerCallId) {
      const dup = await this.getByProviderCallId(c.providerCallId);
      if (dup) return dup;
    }
    const rec = { id: randomUUID(), ...emptyCall(c) };
    this.calls.set(rec.id, rec);
    return rec;
  }
  async updateCall(id, patch) {
    const cur = this.calls.get(id);
    if (!cur) throw new Error(`call ${id} not found`);
    const defined = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== void 0));
    const next = { ...cur, ...defined };
    this.calls.set(id, next);
    return next;
  }
  async getByProviderCallId(pid) {
    return [...this.calls.values()].find((c) => c.providerCallId === pid) ?? null;
  }
  async addCosts(callId, entries) {
    for (const e of entries)
      this.costs.push({ ...e, id: randomUUID(), callId, createdAt: (/* @__PURE__ */ new Date()).toISOString() });
  }
  async listCalls({ from, to }) {
    return [...this.calls.values()].filter((c) => c.startedAt >= from && c.startedAt < to);
  }
  async listCosts({ from, to }) {
    const ids = new Set((await this.listCalls({ from, to })).map((c) => c.id));
    return this.costs.filter((c) => ids.has(c.callId));
  }
  async listFixedCosts() {
    return this.fixed;
  }
  async addFixedCost(f2) {
    this.fixed.push(f2);
  }
  async recordProviderEvent(e) {
    if (this.events.has(e.id)) return false;
    this.events.set(e.id, { type: e.type, payload: e.payload });
    return true;
  }
};

// src/db/postgres.ts
import pg from "pg";
var snake = (s) => s.replace(/[A-Z]/g, (m) => "_" + m.toLowerCase());
var camel = (s) => s.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
var JSONB_COLUMNS = /* @__PURE__ */ new Set(["transcript", "facts", "checks", "session_state"]);
var typeParsers = {
  getTypeParser(oid, format) {
    if (oid === 1184 || oid === 1114) return (v) => new Date(v).toISOString();
    if (oid === 1082) return (v) => v;
    if (oid === 1700) return (v) => Number(v);
    return pg.types.getTypeParser(oid, format);
  }
};
function fromRow(r) {
  return Object.fromEntries(Object.entries(r).map(([k, v]) => [camel(k), v]));
}
var PostgresRepository = class _PostgresRepository {
  db;
  constructor(db) {
    this.db = db;
  }
  static fromUrl(url) {
    return new _PostgresRepository(new pg.Pool({ connectionString: url, max: 3, types: typeParsers }));
  }
  val(col, v) {
    return JSONB_COLUMNS.has(col) && v !== null && v !== void 0 ? JSON.stringify(v) : v;
  }
  async createCall(c) {
    const rec = emptyCall(c);
    const cols = Object.keys(rec).map(snake);
    const params = Object.entries(rec).map(([k, v]) => this.val(snake(k), v));
    const marks = cols.map((col, i) => JSONB_COLUMNS.has(col) ? `$${i + 1}::jsonb` : `$${i + 1}`);
    const ins = await this.db.query(
      `insert into calls (${cols.join(", ")}) values (${marks.join(", ")}) on conflict (provider_call_id) do nothing returning *`,
      params
    );
    if (ins.rows.length) return fromRow(ins.rows[0]);
    const existing = c.providerCallId ? await this.getByProviderCallId(c.providerCallId) : null;
    if (!existing) throw new Error("createCall: insert returned no row and no existing call found");
    return existing;
  }
  async updateCall(id, patch) {
    const entries = Object.entries(patch).filter(([, v]) => v !== void 0);
    if (!entries.length) {
      const cur = await this.db.query("select * from calls where id = $1", [id]);
      if (!cur.rows.length) throw new Error(`call ${id} not found`);
      return fromRow(cur.rows[0]);
    }
    const sets = entries.map(([k], i) => {
      const col = snake(k);
      return `${col} = $${i + 2}${JSONB_COLUMNS.has(col) ? "::jsonb" : ""}`;
    });
    const res = await this.db.query(`update calls set ${sets.join(", ")} where id = $1 returning *`, [id, ...entries.map(([k, v]) => this.val(snake(k), v))]);
    if (!res.rows.length) throw new Error(`call ${id} not found`);
    return fromRow(res.rows[0]);
  }
  async getByProviderCallId(pid) {
    const r = await this.db.query("select * from calls where provider_call_id = $1 limit 1", [pid]);
    return r.rows.length ? fromRow(r.rows[0]) : null;
  }
  async addCosts(callId, entries) {
    for (const e of entries) {
      await this.db.query(
        "insert into call_costs (call_id, service, units, unit, cost_inr, rate_note) values ($1, $2, $3, $4, $5, $6)",
        [callId, e.service, e.units, e.unit, e.costInr, e.rateNote ?? null]
      );
    }
  }
  async listCalls({ from, to }) {
    const r = await this.db.query("select * from calls where started_at >= $1 and started_at < $2 order by started_at desc limit 5000", [from, to]);
    return r.rows.map((x) => fromRow(x));
  }
  async listCosts({ from, to }) {
    const r = await this.db.query(
      "select c.* from call_costs c join calls k on k.id = c.call_id where k.started_at >= $1 and k.started_at < $2 limit 20000",
      [from, to]
    );
    return r.rows.map((x) => fromRow(x));
  }
  async listFixedCosts() {
    const r = await this.db.query("select service, monthly_inr, active_from, active_to from fixed_costs");
    return r.rows.map((x) => fromRow(x));
  }
  async addFixedCost(f2) {
    await this.db.query("insert into fixed_costs (service, monthly_inr, active_from, active_to) values ($1, $2, $3, $4)", [f2.service, f2.monthlyInr, f2.activeFrom, f2.activeTo]);
  }
  async recordProviderEvent(e) {
    const r = await this.db.query(
      "insert into provider_events (id, type, payload) values ($1, $2, $3::jsonb) on conflict (id) do nothing returning id",
      [e.id, e.type, JSON.stringify(e.payload)]
    );
    return r.rows.length > 0;
  }
};

// src/db/supabase.ts
var snake2 = (s) => s.replace(/[A-Z]/g, (m) => "_" + m.toLowerCase());
var camel2 = (s) => s.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
var mapKeys = (o, fn) => Object.fromEntries(Object.entries(o).map(([k, v]) => [fn(k), v]));
var toRow = (c) => mapKeys(c, snake2);
var fromRow2 = (r) => mapKeys(r, camel2);
var SupabaseRepository = class {
  url;
  serviceKey;
  fetchImpl;
  constructor(url, serviceKey, fetchImpl = fetch) {
    this.url = url;
    this.serviceKey = serviceKey;
    this.fetchImpl = fetchImpl;
  }
  async req(path, init = {}) {
    const res = await this.fetchImpl(`${this.url}/rest/v1/${path}`, {
      ...init,
      headers: {
        apikey: this.serviceKey,
        Authorization: `Bearer ${this.serviceKey}`,
        "Content-Type": "application/json",
        ...init.prefer ? { Prefer: init.prefer } : {}
      }
    });
    if (!res.ok) throw new Error(`Supabase ${init.method ?? "GET"} ${path} -> ${res.status}: ${await res.text()}`);
    return res.status === 204 ? null : res.json();
  }
  async createCall(c) {
    const body = toRow(emptyCall(c));
    const rows = await this.req("calls?on_conflict=provider_call_id", {
      method: "POST",
      body: JSON.stringify(body),
      prefer: "resolution=ignore-duplicates,return=representation"
    });
    if (rows.length) return fromRow2(rows[0]);
    const existing = c.providerCallId ? await this.getByProviderCallId(c.providerCallId) : null;
    if (!existing) throw new Error("createCall: insert returned no row and no existing call found");
    return existing;
  }
  async updateCall(id, patch) {
    const rows = await this.req(`calls?id=eq.${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(toRow(patch)),
      prefer: "return=representation"
    });
    if (!rows.length) throw new Error(`call ${id} not found`);
    return fromRow2(rows[0]);
  }
  async getByProviderCallId(pid) {
    const rows = await this.req(`calls?provider_call_id=eq.${encodeURIComponent(pid)}&limit=1`);
    return rows.length ? fromRow2(rows[0]) : null;
  }
  async addCosts(callId, entries) {
    if (!entries.length) return;
    await this.req("call_costs", {
      method: "POST",
      body: JSON.stringify(entries.map((e) => toRow({ callId, ...e }))),
      prefer: "return=minimal"
    });
  }
  async listCalls({ from, to }) {
    const rows = await this.req(`calls?started_at=gte.${encodeURIComponent(from)}&started_at=lt.${encodeURIComponent(to)}&order=started_at.desc&limit=5000`);
    return rows.map((r) => fromRow2(r));
  }
  async listCosts({ from, to }) {
    const rows = await this.req(`call_costs?select=*,calls!inner(started_at)&calls.started_at=gte.${encodeURIComponent(from)}&calls.started_at=lt.${encodeURIComponent(to)}&limit=20000`);
    return rows.map((r) => {
      const { calls: _c, ...rest } = r;
      return fromRow2(rest);
    });
  }
  async listFixedCosts() {
    const rows = await this.req("fixed_costs?select=*");
    return rows.map((r) => fromRow2(r));
  }
  async addFixedCost(f2) {
    await this.req("fixed_costs", { method: "POST", body: JSON.stringify(toRow(f2)), prefer: "return=minimal" });
  }
  async recordProviderEvent(e) {
    const rows = await this.req("provider_events?on_conflict=id", {
      method: "POST",
      body: JSON.stringify({ id: e.id, type: e.type, payload: e.payload }),
      prefer: "resolution=ignore-duplicates,return=representation"
    });
    return rows.length > 0;
  }
};

// src/db/index.ts
function createRepository(env = process.env) {
  if (env.DATABASE_URL) return PostgresRepository.fromUrl(env.DATABASE_URL);
  const url = env.SUPABASE_URL, key = env.SUPABASE_SERVICE_ROLE_KEY;
  return url && key ? new SupabaseRepository(url, key) : new MemoryRepository();
}
var hasDatabase = (env) => Boolean(env.DATABASE_URL || env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY);

// src/core/costs.ts
var DEFAULT_RATES = {
  usdToInr: 88,
  // ASSUMPTION
  // Rs 5.58/min is what the Vaani dashboard shows as the estimate for this agent (app.vaanivoice.ai).
  // It may exclude telephony and can change with the agent's voice and model choices; confirm on the first bills.
  vaaniPerMinuteInr: 5.58,
  geminiInputPerMTokUsd: 0.3,
  geminiOutputPerMTokUsd: 2.5,
  calcomPerBookingInr: 0,
  telegramPerMessageInr: 0,
  hubspotPerDealInr: 0
};
var round = (n) => Math.round(n * 1e4) / 1e4;
function vaaniCost(durationSec, r = DEFAULT_RATES) {
  const minutes = durationSec / 60;
  return {
    service: "vaani",
    units: round(minutes),
    unit: "minute",
    costInr: r.vaaniPerMinuteInr === null ? null : round(minutes * r.vaaniPerMinuteInr),
    rateNote: r.vaaniPerMinuteInr === null ? "Vaani rate not yet confirmed" : "estimate shown in the Vaani dashboard for this agent; may exclude telephony"
  };
}
function geminiCost(inputTokens, outputTokens, r = DEFAULT_RATES) {
  const inr = (tok, usdPerM) => round(tok / 1e6 * usdPerM * r.usdToInr);
  return [
    { service: "gemini", units: inputTokens, unit: "input_token", costInr: inr(inputTokens, r.geminiInputPerMTokUsd) },
    { service: "gemini", units: outputTokens, unit: "output_token", costInr: inr(outputTokens, r.geminiOutputPerMTokUsd) }
  ];
}
var calcomCost = (r = DEFAULT_RATES) => ({ service: "calcom", units: 1, unit: "request", costInr: r.calcomPerBookingInr });
var telegramCost = (r = DEFAULT_RATES) => ({ service: "telegram", units: 1, unit: "request", costInr: r.telegramPerMessageInr });
var hubspotCost = (r = DEFAULT_RATES) => ({ service: "hubspot", units: 1, unit: "request", costInr: r.hubspotPerDealInr });
function totalCost(entries) {
  let inr = 0, incomplete = false;
  for (const e of entries) {
    if (e.costInr === null) incomplete = true;
    else inr += e.costInr;
  }
  return { inr: round(inr), incomplete };
}

// src/core/config.ts
var MIN_LEAD_WEEKS = 6;
var SERVICE_AREAS_LISTED = [
  "pune",
  "pcmc",
  "pimpri chinchwad",
  "pimpri-chinchwad",
  "kothrud",
  "baner",
  "aundh",
  "wakad",
  "koregaon park",
  "kalyani nagar",
  "viman nagar",
  "hadapsar",
  "magarpatta",
  "nibm",
  "kondhwa",
  "undri",
  "shivane",
  "warje",
  "erandwane",
  "deccan",
  "pimpri",
  "chinchwad",
  "pimple saudagar",
  "pimple nilakh",
  "ravet",
  "hinjewadi"
];
var SERVICE_AREAS_ADJOINING = [
  "kharadi",
  "nanded city",
  "sunderban",
  "dahanukar colony",
  "pashan",
  "balewadi",
  "bavdhan",
  "wanowrie",
  "camp",
  "swargate",
  "sinhagad road",
  "karve nagar",
  "yerawada",
  "mundhwa",
  "kalyani",
  "cybercity",
  "sangvi",
  "pimple gurav",
  "wagholi",
  "katraj",
  "bibwewadi",
  "sadashiv peth",
  "shivajinagar",
  "model colony"
];
var HARD_OUT_OF_AREA = ["talegaon", "lonavala", "nashik", "mumbai"];
var OTHER_CITIES = [
  "nagpur",
  "bangalore",
  "bengaluru",
  "delhi",
  "hyderabad",
  "chennai",
  "kolkata",
  "ahmedabad",
  "kolhapur",
  "satara",
  "solapur",
  "aurangabad",
  "navi mumbai",
  "thane",
  "goa",
  "surat",
  "indore"
];
var COMMERCIAL_MAX_SQFT = 3e3;
var COMMERCIAL_MIN_SQFT = 500;
var BUDGET_CLEARLY_BELOW_RATIO = 0.6;
var BUDGET_FLOOR_LAKH = {
  singleRoom: 3.5,
  // pricing.md: single room all-in, low end
  perSqftHome: 0.018,
  // Rs 1,800 per sq ft, in lakh
  perSqftCommercial: 0.012
  // Rs 1,200 per sq ft, in lakh
};

// src/core/scripts.ts
var DECLINE_SCRIPT = "This sounds like it may not be the right fit for us right now \u2014 but feel free to reach out if your timeline or scope changes.";
var QUESTIONS = {
  c1Probe: "And are you looking for a full redesign with our team handling everything, or just some direction on what to do?",
  c2: "Whereabouts is the property?",
  // NOT IN SPEC: spec says "ask one direct follow-up" without wording.
  c2FollowUp: "Just to confirm, is that within Pune or Pimpri-Chinchwad?",
  c3: "What timeline are you working with?",
  // From qualified.md.
  c3FollowUp: "When would you need the project complete?",
  c5: "Will you be the one deciding on this, or is someone else involved too?"
};
var ESCALATION_SCRIPT = "I'm very sorry about that. I'm getting this to our senior team right now, and someone senior will call you back within 15 minutes.";
function deferralScript(earliestStart) {
  return `I want to be honest with you: we need at least six weeks before execution can begin, so we couldn't do this justice in that time. The earliest we could realistically start is around ${earliestStart}. Would you like me to book a consultation for that window?`;
}

// src/core/qualify.ts
var OUT_OF_SCOPE = {
  restaurant: "restaurant (hospitality) is out of scope",
  hotel: "hotel (hospitality) is out of scope",
  retail: "retail is out of scope",
  gym: "gym is out of scope",
  architecture_structural: "architecture/structural work is out of scope",
  decor_only: "decor/styling only is out of scope",
  furniture_only: "standalone furniture sourcing is out of scope",
  vastu_only: "Vastu-only consultation is out of scope"
};
var has = (haystack, needles) => needles.some((n) => haystack.includes(n));
function checkRealProject(f2) {
  if (f2.intent === "advice_only") return "fail";
  if (f2.intent === "full_execution") return "pass";
  return "unclear";
}
function checkServiceArea(f2) {
  if (!f2.location) return "unclear";
  const loc = f2.location.toLowerCase();
  if (has(loc, HARD_OUT_OF_AREA) || has(loc, OTHER_CITIES)) return "fail";
  if (has(loc, SERVICE_AREAS_LISTED) || has(loc, SERVICE_AREAS_ADJOINING)) return "pass";
  return "unclear";
}
function checkTimeline(f2) {
  const t = f2.timeline;
  if (t.kind === "flexible") return "pass";
  if (t.kind === "unknown" || t.weeks === null) return "unclear";
  return t.weeks < MIN_LEAD_WEEKS ? "fail" : "pass";
}
function budgetFloorLakh(f2) {
  const sqft = f2.sqft ?? 0;
  if (f2.serviceType === "single_room") return BUDGET_FLOOR_LAKH.singleRoom;
  if (f2.serviceType === "partial_home") return BUDGET_FLOOR_LAKH.singleRoom;
  if (f2.serviceType === "commercial_office")
    return Math.max(BUDGET_FLOOR_LAKH.singleRoom, sqft * BUDGET_FLOOR_LAKH.perSqftCommercial);
  return Math.max(BUDGET_FLOOR_LAKH.singleRoom, sqft * BUDGET_FLOOR_LAKH.perSqftHome);
}
function checkBudget(f2) {
  if (!f2.budgetLakh) return { status: "pass", borderline: false };
  const floor = budgetFloorLakh(f2);
  if (f2.budgetLakh.max < floor * BUDGET_CLEARLY_BELOW_RATIO)
    return { status: "fail", borderline: false };
  return { status: "pass", borderline: f2.budgetLakh.max < floor };
}
function checkDecisionMaker(f2) {
  if (f2.decisionMaker === "self" || f2.decisionMaker === "authorised" || f2.decisionMaker === "family_attending")
    return "pass";
  return "unclear";
}
function earliestStartDate(today) {
  const d = new Date(today.getTime() + MIN_LEAD_WEEKS * 7 * 864e5);
  return d.toLocaleDateString("en-IN", { day: "numeric", month: "long", year: "numeric" });
}
function evaluate(f2, asked = {}, today = /* @__PURE__ */ new Date()) {
  if (f2.existingClient) {
    return {
      verdict: "escalated",
      checks: null,
      reasons: ["existing project issue; qualification skipped"],
      flags: [],
      say: ESCALATION_SCRIPT
    };
  }
  const oos = OUT_OF_SCOPE[f2.serviceType];
  if (oos) {
    return { verdict: "declined", checks: null, reasons: [oos], flags: [], say: DECLINE_SCRIPT };
  }
  if (f2.serviceType === "commercial_office" && f2.sqft !== null) {
    if (f2.sqft < COMMERCIAL_MIN_SQFT)
      return {
        verdict: "declined",
        checks: null,
        reasons: [`commercial space of ${f2.sqft} sq ft is below the ${COMMERCIAL_MIN_SQFT} sq ft minimum scope`],
        flags: [],
        say: DECLINE_SCRIPT
      };
    if (f2.sqft > COMMERCIAL_MAX_SQFT)
      return {
        verdict: "declined",
        checks: null,
        reasons: [`commercial space of ${f2.sqft} sq ft is above the ~${COMMERCIAL_MAX_SQFT} sq ft maximum`],
        flags: [],
        say: DECLINE_SCRIPT
      };
  }
  const budget = checkBudget(f2);
  const checks = {
    c1: checkRealProject(f2),
    c2: checkServiceArea(f2),
    c3: checkTimeline(f2),
    c4: budget.status,
    c5: checkDecisionMaker(f2)
  };
  const labels = {
    c1: "not a real project (advice only)",
    c2: "outside service area",
    c3: "timeline under the 6-week minimum lead time",
    c4: "volunteered budget clearly below scope",
    c5: "decision-maker"
  };
  const failed = Object.keys(checks).filter((c) => checks[c] === "fail");
  const reasonsFor = (cs) => cs.map((c) => labels[c]);
  if (failed.length >= 2)
    return { verdict: "declined", checks, reasons: reasonsFor(failed), flags: [], say: DECLINE_SCRIPT };
  if (checks.c1 === "fail" || checks.c2 === "fail")
    return { verdict: "declined", checks, reasons: reasonsFor(failed), flags: [], say: DECLINE_SCRIPT };
  if (checks.c4 === "fail")
    return { verdict: "declined", checks, reasons: reasonsFor(failed), flags: [], say: DECLINE_SCRIPT };
  if (checks.c3 === "fail") {
    const start = earliestStartDate(today);
    return {
      verdict: "deferred",
      checks,
      reasons: reasonsFor(failed),
      flags: [],
      say: deferralScript(start),
      earliestStart: start
    };
  }
  const n = (c) => asked[c] ?? 0;
  const flags = [];
  const next = nextQuestion(checks, n);
  if (next) return { verdict: "needs_followup", checks, reasons: [], flags: [], say: next.say, ask: next.ask };
  if (checks.c1 === "unclear") flags.push("Not confirmed that this is a full design + execution project");
  if (checks.c2 === "unclear") flags.push("Location not confirmed as within Pune/PCMC");
  if (checks.c3 === "unclear") flags.push("Timeline not stated or confirmed");
  if (checks.c5 === "unclear") flags.push("Decision-maker not confirmed" + (f2.decisionMakerNote ? ` (${f2.decisionMakerNote})` : ""));
  if (budget.borderline) flags.push("Volunteered budget is borderline for the described scope");
  return { verdict: "qualified", checks, reasons: [], flags, say: null };
}
function nextQuestion(checks, asked) {
  if (checks.c1 === "unclear" && asked("c1") < 1) return { ask: "c1", say: QUESTIONS.c1Probe };
  if (checks.c2 === "unclear") {
    if (asked("c2") < 1) return { ask: "c2", say: QUESTIONS.c2 };
    if (asked("c2") < 2) return { ask: "c2", say: QUESTIONS.c2FollowUp };
  }
  if (checks.c3 === "unclear") {
    if (asked("c3") < 1) return { ask: "c3", say: QUESTIONS.c3 };
    if (asked("c3") < 2) return { ask: "c3", say: QUESTIONS.c3FollowUp };
  }
  if (checks.c5 === "unclear" && asked("c5") < 1) return { ask: "c5", say: QUESTIONS.c5 };
  return null;
}

// src/core/hours.ts
var IST_OFFSET_MIN = 330;
function isAfterHours(iso) {
  const d = new Date(new Date(iso).getTime() + IST_OFFSET_MIN * 6e4);
  const mins = d.getUTCHours() * 60 + d.getUTCMinutes();
  return mins < 10 * 60 || mins >= 19 * 60;
}

// src/db/recorder.ts
async function startCall(repo, a) {
  return repo.createCall({
    providerCallId: a.providerCallId ?? null,
    startedAt: a.startedAt,
    answerLatencyMs: a.answerLatencyMs,
    callerPhone: a.callerPhone ?? null,
    afterHours: isAfterHours(a.startedAt)
  });
}
async function finishCall(repo, callId, o) {
  const d = o.decision;
  const verdict = !d || d.verdict === "needs_followup" ? "abandoned" : d.verdict;
  let handoff = o.handoff?.status ?? "not_applicable";
  if (!o.handoff) {
    if (verdict === "qualified") handoff = "pending";
    if (verdict === "escalated") handoff = "escalation_pending";
  }
  const rec = await repo.updateCall(callId, {
    endedAt: o.endedAt,
    durationSec: o.durationSec,
    transcript: o.transcript,
    facts: o.facts,
    callerName: o.facts?.callerName ?? null,
    callerPhone: o.facts?.phone ?? void 0,
    checks: d?.checks ?? null,
    verdict,
    reasons: d?.reasons ?? (d ? [] : [o.reasonOverride ?? "caller hung up before qualification finished"]),
    flags: d?.flags ?? [],
    pricingAsked: o.pricingAsked,
    auditIssues: o.auditIssues ?? null,
    handoffStatus: handoff,
    bookingStatus: o.booking?.status ?? (verdict === "qualified" ? "offered" : "not_applicable"),
    bookingTime: o.booking?.time ?? null,
    bookingRef: o.booking?.ref ?? null,
    crmStatus: o.crm?.status ?? (verdict === "qualified" ? "pending" : "not_applicable"),
    crmDealId: o.crm?.dealId ?? null
  });
  await repo.addCosts(callId, o.costs);
  return rec;
}

// src/fixtures/phone-transcripts.ts
var base = {
  existingClient: false,
  serviceType: "unknown",
  intent: "unclear",
  location: null,
  sqft: null,
  rooms: null,
  currentState: null,
  timeline: { kind: "unknown", weeks: null },
  decisionMaker: "unknown",
  budgetLakh: null
};
var f = (p) => ({ ...base, ...p });
var PHONE_FIXTURES = [
  {
    id: "T01",
    summary: "3BHK Kothrud, full redo, done by March, husband agrees",
    expected: "qualified",
    facts: f({ callerName: "Priya", serviceType: "full_home", intent: "full_execution", location: "Kothrud (Dahanukar Colony)", sqft: 1400, currentState: "lived-in, builder finish", timeline: { kind: "complete_by", weeks: 26 }, decisionMaker: "authorised", decisionMakerNote: "husband aware and happy to go ahead" })
  },
  {
    id: "T02",
    summary: "2BHK Wakad, full redesign, asks price twice",
    expected: "qualified",
    facts: f({ serviceType: "full_home", intent: "full_execution", location: "Wakad", sqft: 950, currentState: "moving in November", timeline: { kind: "complete_by", weeks: 8 } }),
    pricingQuestions: ["can you tell me roughly how much something like that would cost?", "can you give me a rough ballpark first? Even a range?"],
    note: "Decision-maker never asked in transcript"
  },
  {
    id: "T03",
    summary: "Home office and study in Nashik",
    expected: "declined",
    facts: f({ callerName: "Suresh Patil", serviceType: "partial_home", rooms: 2, location: "Nashik" })
  },
  {
    id: "T04",
    summary: "Living room: just ideas on colours and arrangement",
    expected: "declined",
    facts: f({ serviceType: "single_room", rooms: 1, intent: "advice_only" })
  },
  {
    id: "T05",
    summary: "4BHK Koregaon Park, complete redesign, ~4 months",
    expected: "qualified",
    facts: f({ callerName: "Aarti Mehta", serviceType: "full_home", intent: "full_execution", location: "Koregaon Park", sqft: 2400, currentState: "family moved out temporarily", timeline: { kind: "complete_by", weeks: 17 } }),
    note: "Decision-maker never asked in transcript"
  },
  {
    id: "T06",
    summary: "800 sq ft startup office, Baner, founder",
    expected: "qualified",
    facts: f({ serviceType: "commercial_office", intent: "full_execution", location: "Baner", sqft: 800, currentState: "bare shell", timeline: { kind: "complete_by", weeks: 12 }, decisionMaker: "self", decisionMakerNote: "founder" })
  },
  {
    id: "T07",
    summary: "Living room + kitchen before Diwali (3 weeks), then 'start after Diwali'",
    expected: "deferred",
    facts: f({ serviceType: "partial_home", rooms: 2, intent: "full_execution", timeline: { kind: "complete_by", weeks: 3 }, decisionMaker: "self" })
  },
  {
    id: "T08",
    summary: "Missed call 10:47pm, no voicemail, callback unanswered",
    expected: "ops_failure",
    facts: null,
    note: "Operational failure. The new system answers every call, so there is nothing to classify."
  },
  {
    id: "T09",
    summary: "Existing client: designer silent for 5 days",
    expected: "escalated",
    facts: f({ callerName: "Sheetal Deshpande", existingClient: true, location: "Viman Nagar" })
  },
  {
    id: "T10",
    summary: "1BHK Kharadi kitchen + bedroom, budget Rs 1-1.5 lakh max",
    expected: "declined",
    facts: f({ serviceType: "partial_home", rooms: 2, intent: "full_execution", location: "Kharadi", sqft: 550, budgetLakh: { min: 1, max: 1.5 } })
  },
  {
    id: "T11",
    summary: "Rented 2BHK Baner, living + bedroom + kitchen, no structural",
    expected: "qualified",
    facts: f({ serviceType: "partial_home", rooms: 3, intent: "full_execution", location: "Baner", currentState: "rented, bare", decisionMaker: "self", decisionMakerNote: "tenant on 3-year lease, landlord approved" }),
    note: "Timeline never stated in transcript"
  },
  {
    id: "T12",
    summary: "5,500 sq ft villa Kalyani Nagar, new, move in March",
    expected: "qualified",
    facts: f({ callerName: "Anand Sharma", serviceType: "full_home", intent: "full_execution", location: "Kalyani Nagar", sqft: 5500, currentState: "new construction, empty", timeline: { kind: "complete_by", weeks: 24 }, decisionMaker: "self" })
  },
  {
    id: "T13",
    summary: "3BHK Aundh 1,100 sq ft, asks for a rough range",
    expected: "qualified",
    facts: f({ serviceType: "full_home", intent: "full_execution", location: "Aundh", sqft: 1100, decisionMaker: "self" }),
    pricingQuestions: ["What might it cost?", "can't you give me even a rough range? I just want to know if we're in the same ballpark."],
    note: "Timeline never stated in transcript"
  },
  {
    id: "T14",
    summary: "Son calling for parents' new 3BHK Hadapsar; parents will attend",
    expected: "qualified",
    facts: f({ serviceType: "full_home", intent: "full_execution", location: "Hadapsar", currentState: "new possession", decisionMaker: "family_attending", decisionMakerNote: "caller is the son; parents own the flat and will attend and decide" }),
    note: "Timeline never stated. 'Proper design' read as a full project."
  },
  {
    id: "T15",
    summary: "2BHK Undri 875 sq ft, possession in 6 weeks",
    expected: "qualified",
    facts: f({ callerName: "Smita", serviceType: "full_home", intent: "full_execution", location: "Undri", sqft: 875, currentState: "awaiting possession; builder allows site access", timeline: { kind: "start_by", weeks: 6 }, decisionMaker: "authorised", decisionMakerNote: "husband said to go ahead" }),
    note: "Exactly at the 6-week boundary"
  },
  {
    id: "T16",
    summary: "Callback chaser: 3BHK Viman Nagar, earlier lead never logged",
    expected: "qualified",
    facts: f({ callerName: "Girish Nair", serviceType: "full_home", location: "Viman Nagar" }),
    note: "Spec counts this as qualified AND as an ops failure. Transcript holds almost no qualifying detail."
  },
  {
    id: "T17",
    summary: "First call dropped; second call: 3BHK Pimple Saudagar 1,050 sq ft",
    expected: "qualified",
    facts: f({ callerName: "Ritu Kapoor", serviceType: "full_home", intent: "full_execution", location: "Pimple Saudagar", sqft: 1050, currentState: "lived-in, builder furniture", timeline: { kind: "complete_by", weeks: 23 } }),
    note: "Dropped first call must be logged as abandoned. Decision-maker never asked."
  },
  {
    id: "T18",
    summary: "180 sq ft coworking pod",
    expected: "declined",
    facts: f({ serviceType: "commercial_office", sqft: 180 }),
    note: "Relies on the 500 sq ft floor, which is only in the transcript, not services.md"
  },
  {
    id: "T19",
    summary: "Restaurant in Koregaon Park",
    expected: "declined",
    facts: f({ serviceType: "restaurant", location: "Koregaon Park" })
  },
  {
    id: "T20",
    summary: "2BHK Magarpatta 900 sq ft, January start, both attend",
    expected: "qualified",
    facts: f({ callerName: "Pooja", serviceType: "full_home", intent: "full_execution", location: "Magarpatta", sqft: 900, timeline: { kind: "start_by", weeks: 14 }, decisionMaker: "authorised", decisionMakerNote: "husband will attend the consultation" })
  }
];

// src/fixtures/seed.ts
function sampleTranscript(f2, at) {
  const turn = (speaker, text) => ({ speaker, text, at });
  return [
    turn("agent", "Good morning, Aangan Studio \u2014 how can I help you today?"),
    turn("caller", `Hi, I have a ${f2.serviceType.replace(/_/g, " ")} project${f2.location ? " in " + f2.location : ""}${f2.sqft ? ", about " + f2.sqft + " sq ft" : ""}. (sample data)`),
    turn("agent", "Thank you for calling Aangan Studio.")
  ];
}
function rng(seed) {
  let s = seed;
  return () => (s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296;
}
async function seedDemo(repo, opts = {}) {
  const days = opts.days ?? 30, n = opts.calls ?? 70, now = opts.now ?? /* @__PURE__ */ new Date();
  const r = rng(42);
  await repo.addFixedCost({ service: "Phone number rental + telephony", monthlyInr: null, activeFrom: "2020-01-01", activeTo: null });
  const usable = PHONE_FIXTURES.filter((f2) => f2.facts);
  for (let i = 0; i < n; i++) {
    const fx = usable[Math.floor(r() * usable.length)];
    const after = r() < 0.33;
    const dayOffset = Math.floor(r() * days);
    const istMinutes = after ? r() < 0.5 ? Math.floor(r() * 9 * 60) : 19 * 60 + Math.floor(r() * 5 * 60) : 10 * 60 + Math.floor(r() * 9 * 60);
    const day = new Date(now.getTime() - dayOffset * 864e5);
    const startedAt = new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), 0, 0) + (istMinutes - 330) * 6e4).toISOString();
    if (new Date(startedAt) > now || new Date(startedAt).getTime() < now.getTime() - days * 864e5) {
      i--;
      continue;
    }
    const duration = 90 + Math.floor(r() * 300);
    const rec = await startCall(repo, { providerCallId: `demo-${i}`, startedAt, answerLatencyMs: 600 + Math.floor(r() * 1400), callerPhone: `+9198${String(1e7 + Math.floor(r() * 89999999))}` });
    const decision = evaluate(fx.facts, { c1: 1, c3: 2, c5: 1, c2: 2 }, new Date(startedAt));
    const qualified = decision.verdict === "qualified";
    const booked = qualified && r() < 0.75;
    const handoffFailed = qualified && r() < 0.04;
    const costs = [vaaniCost(duration), ...geminiCost(2500 + Math.floor(r() * 2500), 300 + Math.floor(r() * 300))];
    if (qualified) costs.push(telegramCost(), hubspotCost(), calcomCost());
    await finishCall(repo, rec.id, {
      decision,
      facts: { ...fx.facts, callerName: fx.facts.callerName ?? null },
      transcript: sampleTranscript(fx.facts, startedAt),
      endedAt: new Date(new Date(startedAt).getTime() + duration * 1e3).toISOString(),
      durationSec: duration,
      pricingAsked: !!fx.pricingQuestions,
      auditIssues: r() < 0.04 ? ["price_quoted", "pricing_line_not_verbatim"] : [],
      booking: qualified ? { status: booked ? "booked" : "declined_by_caller", time: booked ? new Date(new Date(startedAt).getTime() + 3 * 864e5).toISOString() : void 0 } : void 0,
      handoff: qualified ? { status: handoffFailed ? "failed" : "sent" } : void 0,
      crm: qualified ? { status: "created", dealId: `demo-deal-${i}` } : void 0,
      costs
    });
  }
}

// src/core/faq.ts
var FAQ_ANSWERS = {
  services: "Aangan Studio does end-to-end interior design for homes and small offices in Pune and PCMC \u2014 space planning, materials, furniture, lighting, kitchens and wardrobes, and we supervise the execution with our own contractors.",
  service_area: "We work across Pune city and PCMC, including Pimpri, Chinchwad, Pimple Saudagar, Ravet and Hinjewadi. We don't currently take projects outside that area.",
  timelines: "The design phase takes three to four weeks from the first consultation, and execution usually takes eight to sixteen weeks depending on the size of the project. We need at least six weeks before execution can begin.",
  commercial: "For offices, clinics and studios we take projects up to about three thousand square feet, including workstations, cabins, reception and common areas.",
  not_offered: "We don't do architecture or structural work, decor or styling on its own, standalone furniture sourcing, Vastu-only advice, or restaurants, hotels, retail stores and gyms.",
  rented: "Yes, we've worked on rented apartments, as long as there are no structural changes."
};
var FAQ_TOPICS = Object.keys(FAQ_ANSWERS);

// src/integrations/gemini.ts
var SERVICE_TYPES = ["full_home", "partial_home", "single_room", "commercial_office", "restaurant", "hotel", "retail", "gym", "architecture_structural", "decor_only", "furniture_only", "vastu_only", "unknown"];
var INTENTS = ["full_execution", "advice_only", "unclear"];
var DECISION_MAKERS = ["self", "authorised", "family_attending", "research_only", "unknown"];
var TIMELINE_KINDS = ["start_by", "complete_by", "flexible", "unknown"];
var EXTRACT_SCHEMA = {
  type: "OBJECT",
  properties: {
    callerName: { type: "STRING", nullable: true },
    phone: { type: "STRING", nullable: true },
    existingClient: { type: "BOOLEAN" },
    serviceType: { type: "STRING", enum: SERVICE_TYPES },
    intent: { type: "STRING", enum: INTENTS },
    location: { type: "STRING", nullable: true },
    sqft: { type: "INTEGER", nullable: true },
    rooms: { type: "INTEGER", nullable: true },
    currentState: { type: "STRING", nullable: true },
    timeline: {
      type: "OBJECT",
      properties: { kind: { type: "STRING", enum: [...TIMELINE_KINDS] }, weeks: { type: "INTEGER", nullable: true } },
      required: ["kind"]
    },
    decisionMaker: { type: "STRING", enum: DECISION_MAKERS },
    decisionMakerNote: { type: "STRING", nullable: true },
    // Whole rupees, not lakh: a decimal like 1.5 made the model loop on zeros.
    preferredStart: { type: "STRING", nullable: true },
    budgetMinRupees: { type: "INTEGER", nullable: true },
    budgetMaxRupees: { type: "INTEGER", nullable: true }
  },
  required: ["existingClient", "serviceType", "intent", "timeline", "decisionMaker"]
};

// src/server/dashboard-http.ts
import { timingSafeEqual } from "node:crypto";

// src/db/summary.ts
var pct = (sorted, p) => sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)] : null;
var DAY = 864e5;
function fixedForRange(fixed, r) {
  let inr = 0, incomplete = false;
  const from = new Date(r.from).getTime(), to = new Date(r.to).getTime();
  for (const f2 of fixed) {
    const start = Math.max(from, new Date(f2.activeFrom).getTime());
    const end = Math.min(to, f2.activeTo ? new Date(f2.activeTo).getTime() + DAY : to);
    if (end <= start) continue;
    if (f2.monthlyInr === null) {
      incomplete = true;
      continue;
    }
    inr += f2.monthlyInr * ((end - start) / DAY) / 30;
  }
  return { inr: Math.round(inr * 100) / 100, incomplete };
}
function summarise(calls, costs, fixed, range) {
  const verdicts = {};
  for (const c of calls) verdicts[c.verdict] = (verdicts[c.verdict] ?? 0) + 1;
  const lat = calls.map((c) => c.answerLatencyMs).filter((x) => x !== null).sort((a, b) => a - b);
  const variable = totalCost(costs);
  const fx = fixedForRange(fixed, range);
  const byService = {};
  for (const c of costs) if (c.costInr !== null) byService[c.service] = Math.round(((byService[c.service] ?? 0) + c.costInr) * 1e4) / 1e4;
  const reasons = [];
  if (variable.incomplete) reasons.push("a per-call rate is unknown");
  if (fixed.length === 0) reasons.push("no fixed monthly fees recorded (phone number rental, plan fees)");
  else if (fx.incomplete) reasons.push("a fixed monthly fee is unknown");
  const total = Math.round((variable.inr + fx.inr) * 100) / 100;
  return {
    totalCalls: calls.length,
    afterHoursCalls: calls.filter((c) => c.afterHours).length,
    verdicts,
    consultationsBooked: calls.filter((c) => c.bookingStatus === "booked" || c.bookingStatus === "provisional").length,
    consultationsProvisional: calls.filter((c) => c.bookingStatus === "provisional").length,
    compliance: { audited: calls.filter((c) => c.auditIssues !== null && c.auditIssues !== void 0).length, clean: calls.filter((c) => c.auditIssues && c.auditIssues.length === 0).length },
    pricingQuestions: calls.filter((c) => c.pricingAsked).length,
    latency: {
      medianMs: pct(lat, 0.5),
      p95Ms: pct(lat, 0.95),
      maxMs: lat.length ? lat[lat.length - 1] : null,
      under5MinPct: lat.length ? Math.round(lat.filter((x) => x <= 5 * 6e4).length / lat.length * 1e3) / 10 : null
    },
    cost: {
      perCallInr: variable.inr,
      fixedInr: fx.inr,
      totalInr: total,
      perCallAvgInr: calls.length ? Math.round(total / calls.length * 100) / 100 : null,
      incomplete: reasons.length > 0,
      incompleteReasons: reasons,
      byService
    }
  };
}

// src/db/dashboard.ts
var maskPhone = (p) => p ? "\u2022\u2022\u2022\u2022\u2022\u2022 " + p.replace(/\D/g, "").slice(-4) : null;
var istDate = (iso) => new Date(new Date(iso).getTime() + 330 * 6e4).toISOString().slice(0, 10);
var SERVICE_LABEL = {
  full_home: "Full home",
  partial_home: "Part of a home",
  single_room: "Single room",
  commercial_office: "Office / commercial",
  restaurant: "Restaurant",
  hotel: "Hotel",
  retail: "Retail",
  gym: "Gym",
  architecture_structural: "Architecture / structural",
  decor_only: "Decor only",
  furniture_only: "Furniture only",
  vastu_only: "Vastu only",
  unknown: "Not stated"
};
var lakh = (n) => Number.isInteger(n) ? String(n) : n.toFixed(1);
function describeFacts(f2, fallbackName) {
  if (!f2) return { callerName: fallbackName, project: "Not captured", location: "Not captured", timeline: "Not captured", decisionMaker: "Not captured", budget: "Not captured", currentState: "Not captured" };
  const t = f2.timeline;
  const dm = {
    self: "Caller decides",
    authorised: "Caller, authorised by someone else",
    family_attending: "Family will attend and decide",
    research_only: "Researching for someone else",
    unknown: "Not confirmed"
  };
  return {
    callerName: f2.callerName ?? fallbackName,
    project: [SERVICE_LABEL[f2.serviceType] ?? f2.serviceType, f2.sqft ? `${f2.sqft} sq ft` : null].filter(Boolean).join(" \xB7 "),
    location: f2.location ?? "Not stated",
    timeline: t.kind === "flexible" ? "Flexible" : t.kind === "unknown" || t.weeks === null ? "Not stated" : `${t.kind === "start_by" ? "Start within" : "Finish within"} ~${t.weeks} weeks`,
    decisionMaker: dm[f2.decisionMaker] + (f2.decisionMakerNote ? ` (${f2.decisionMakerNote})` : ""),
    budget: f2.budgetLakh ? `\u20B9${lakh(f2.budgetLakh.min)}\u2013${lakh(f2.budgetLakh.max)} lakh (volunteered)` : "None volunteered",
    currentState: f2.currentState ?? "Not stated"
  };
}
var maskDigits = (text) => text.replace(/\+?\d[\d\s\-]{6,}\d/g, (m) => m.replace(/\D/g, "").length >= 9 ? "\u2022\u2022\u2022\u2022\u2022\u2022 " + m.replace(/\D/g, "").slice(-4) : m);
var safeTranscript = (t) => (t ?? []).slice(0, 200).map((x) => ({ speaker: x.speaker, at: x.at, text: maskDigits(String(x.text).slice(0, 2e3)) }));
function needsAttention(c) {
  return c.handoffStatus === "failed" || c.handoffStatus === "escalation_pending" || c.crmStatus === "failed" || c.bookingStatus === "failed" || c.verdict === "qualified" && c.handoffStatus === "pending" || Boolean(c.auditIssues && c.auditIssues.length);
}
function toRecent(c, costs) {
  const mine = costs.filter((x) => x.callId === c.id);
  return {
    id: c.id,
    startedAt: c.startedAt,
    afterHours: c.afterHours,
    phoneMasked: maskPhone(c.callerPhone),
    name: c.callerName,
    verdict: c.verdict,
    reasons: c.reasons,
    flags: c.flags,
    pricingAsked: c.pricingAsked,
    handoffStatus: c.handoffStatus,
    bookingStatus: c.bookingStatus,
    bookingTime: c.bookingTime,
    crmStatus: c.crmStatus,
    durationSec: c.durationSec,
    answerLatencyMs: c.answerLatencyMs,
    auditIssues: c.auditIssues ?? null,
    details: describeFacts(c.facts, c.callerName),
    transcript: safeTranscript(c.transcript),
    costInr: mine.some((x) => x.costInr === null) || !mine.length ? null : Math.round(mine.reduce((a, x) => a + (x.costInr ?? 0), 0) * 100) / 100
  };
}
async function buildDashboard(repo, range) {
  const [calls, costs, fixed] = await Promise.all([repo.listCalls(range), repo.listCosts(range), repo.listFixedCosts()]);
  const summary = summarise(calls, costs, fixed, range);
  const byDay = /* @__PURE__ */ new Map();
  for (let t = new Date(range.from).getTime(); t < new Date(range.to).getTime(); t += 864e5) {
    byDay.set(istDate(new Date(t).toISOString()), { inHours: 0, afterHours: 0 });
  }
  for (const c of calls) {
    const d = byDay.get(istDate(c.startedAt)) ?? { inHours: 0, afterHours: 0 };
    c.afterHours ? d.afterHours++ : d.inHours++;
    byDay.set(istDate(c.startedAt), d);
  }
  const daily = [...byDay.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([date, v]) => ({ date, ...v }));
  const sorted = [...calls].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  return {
    range,
    summary,
    daily,
    attention: sorted.filter(needsAttention).slice(0, 20).map((c) => toRecent(c, costs)),
    recent: sorted.slice(0, 40).map((c) => toRecent(c, costs))
  };
}

// src/server/dashboard-http.ts
var json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
var DAY2 = 864e5;
var isoDay = /^\d{4}-\d{2}-\d{2}$/;
function createDashboardHandler(repo, cfg) {
  return async function handle(req) {
    if (req.method !== "GET") return json(405, { error: "method not allowed" });
    const a = Buffer.from(req.headers.get("authorization") ?? ""), b = Buffer.from(`Bearer ${cfg.password}`);
    if (!cfg.password || a.length !== b.length || !timingSafeEqual(a, b)) return json(401, { error: "unauthorised" });
    const url = new URL(req.url);
    const now = (cfg.now ?? (() => /* @__PURE__ */ new Date()))();
    const toDay = url.searchParams.get("to") ?? new Date(now.getTime() + 330 * 6e4).toISOString().slice(0, 10);
    const fromDay = url.searchParams.get("from") ?? new Date(now.getTime() + 330 * 6e4 - 29 * DAY2).toISOString().slice(0, 10);
    if (!isoDay.test(fromDay) || !isoDay.test(toDay)) return json(400, { error: "from and to must be YYYY-MM-DD" });
    const from = new Date(Date.parse(fromDay + "T00:00:00Z") - 330 * 6e4);
    const to = new Date(Date.parse(toDay + "T00:00:00Z") + DAY2 - 330 * 6e4);
    if (!(from < to)) return json(400, { error: "from must not be after to" });
    if (to.getTime() - from.getTime() > 400 * DAY2) return json(400, { error: "range too long (max 400 days)" });
    try {
      return json(200, { demo: cfg.demo, ...await buildDashboard(repo, { from: from.toISOString(), to: to.toISOString() }) });
    } catch (e) {
      console.error("dashboard failed", e);
      return json(500, { error: "could not load data" });
    }
  };
}

// src/server/bootstrap.ts
var cache = /* @__PURE__ */ new Map();
var once = (k, f2) => cache.has(k) ? cache.get(k) : (cache.set(k, f2()), cache.get(k));
async function dashboardHandler(env = process.env) {
  const demo = env.DEMO_MODE === "1";
  if (!hasDatabase(env) && !demo) {
    return async () => new Response(JSON.stringify({ error: "The database is not configured. Set DATABASE_URL (Neon), or DEMO_MODE=1 for sample data." }), { status: 503, headers: { "Content-Type": "application/json" } });
  }
  const repo = hasDatabase(env) ? createRepository(env) : once("demo-repo", () => new MemoryRepository());
  if (!hasDatabase(env) && !cache.has("seeded")) {
    cache.set("seeded", true);
    await seedDemo(repo);
  }
  return createDashboardHandler(repo, { password: env.DASHBOARD_PASSWORD ?? "", demo: !hasDatabase(env) });
}

// api-src/dashboard.ts
async function GET(req) {
  return (await dashboardHandler())(req);
}
export {
  GET
};
