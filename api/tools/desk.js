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
var PRICING_DEFLECTION = "Pricing depends on the site, the materials you choose, and the scope \u2014 your designer will walk you through it in detail at the consultation. I can book that for you right now if you'd like.";
var DECLINE_SCRIPT = "This sounds like it may not be the right fit for us right now \u2014 but feel free to reach out if your timeline or scope changes.";
function openingLine(hour) {
  const part = hour < 12 ? "morning" : hour < 17 ? "afternoon" : "evening";
  return `Good ${part}, Aangan Studio \u2014 how can I help you today?`;
}
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

// src/integrations/calcom.ts
var TZ = "Asia/Kolkata";
function slotLabel(startIso) {
  return new Date(startIso).toLocaleString("en-IN", {
    weekday: "long",
    day: "numeric",
    month: "long",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZone: TZ
  });
}
var CalComCalendar = class {
  apiKey;
  eventTypeId;
  emailFallback;
  fetchImpl;
  constructor(apiKey, eventTypeId, emailFallback = "", fetchImpl = fetch) {
    this.apiKey = apiKey;
    this.eventTypeId = eventTypeId;
    this.emailFallback = emailFallback;
    this.fetchImpl = fetchImpl;
  }
  async findSlots(count, after) {
    const end = new Date(after.getTime() + 10 * 864e5);
    const qs = new URLSearchParams({ eventTypeId: String(this.eventTypeId), start: after.toISOString(), end: end.toISOString(), timeZone: TZ });
    const res = await this.fetchImpl(`https://api.cal.com/v2/slots?${qs}`, {
      headers: { Authorization: `Bearer ${this.apiKey}`, "cal-api-version": "2024-09-04" }
    });
    if (!res.ok) throw new Error(`Cal.com slots -> ${res.status}: ${await res.text()}`);
    const body = await res.json();
    const all = Object.values(body.data ?? {}).flat().map((s) => s.start).sort();
    const picked = [];
    for (const s of all) {
      if (picked.length >= count) break;
      if (!picked.length || s.slice(0, 10) !== picked[picked.length - 1].slice(0, 10)) picked.push(s);
    }
    return picked.map((start) => ({ start, label: slotLabel(start) }));
  }
  async book(a) {
    if (!this.emailFallback.includes("@")) throw new Error("CALCOM_EMAIL_FALLBACK is not set (needs a real inbox, e.g. studio+{phone}@yourdomain.com)");
    const digits = (a.phone ?? "unknown").replace(/\D/g, "") || "unknown";
    const res = await this.fetchImpl("https://api.cal.com/v2/bookings", {
      method: "POST",
      headers: { Authorization: `Bearer ${this.apiKey}`, "cal-api-version": "2026-02-25", "Content-Type": "application/json" },
      body: JSON.stringify({
        start: a.slot.start,
        eventTypeId: this.eventTypeId,
        attendee: {
          name: a.name ?? "Caller",
          email: this.emailFallback.replace("{phone}", digits),
          timeZone: TZ,
          ...a.phone ? { phoneNumber: a.phone } : {}
        },
        bookingFieldsResponses: { notes: a.notes }
      })
    });
    if (!res.ok) throw new Error(`Cal.com booking -> ${res.status}: ${await res.text()}`);
    const body = await res.json();
    return { ref: body.data.uid, start: body.data.start };
  }
};

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
var DEFAULT_GEMINI_MODEL = "gemini-3.5-flash-lite";
var SERVICE_TYPES = ["full_home", "partial_home", "single_room", "commercial_office", "restaurant", "hotel", "retail", "gym", "architecture_structural", "decor_only", "furniture_only", "vastu_only", "unknown"];
var INTENTS = ["full_execution", "advice_only", "unclear"];
var DECISION_MAKERS = ["self", "authorised", "family_attending", "research_only", "unknown"];
var TIMELINE_KINDS = ["start_by", "complete_by", "flexible", "unknown"];
var pick = (v, allowed, fallback) => typeof v === "string" && allowed.includes(v) ? v : fallback;
var num = (v) => typeof v === "number" && Number.isFinite(v) ? v : null;
var str = (v) => typeof v === "string" && v.trim() ? v.trim() : null;
function normaliseFacts(raw, prior) {
  const t = raw.timeline ?? {};
  const b = raw.budgetLakh;
  const lo = num(raw.budgetMinRupees), hi = num(raw.budgetMaxRupees);
  const fromRupees = lo !== null || hi !== null ? { min: (lo ?? hi) / 1e5, max: (hi ?? lo) / 1e5 } : null;
  const facts = {
    callerName: str(raw.callerName),
    phone: str(raw.phone),
    existingClient: raw.existingClient === true,
    serviceType: pick(raw.serviceType, SERVICE_TYPES, "unknown"),
    intent: pick(raw.intent, INTENTS, "unclear"),
    location: str(raw.location),
    sqft: num(raw.sqft),
    rooms: num(raw.rooms),
    currentState: str(raw.currentState),
    timeline: {
      kind: pick(t.kind, TIMELINE_KINDS, "unknown"),
      weeks: num(t.weeks)
    },
    decisionMaker: pick(raw.decisionMaker, DECISION_MAKERS, "unknown"),
    decisionMakerNote: str(raw.decisionMakerNote),
    budgetLakh: fromRupees ?? (b && num(b.min) !== null && num(b.max) !== null ? { min: num(b.min), max: num(b.max) } : null)
  };
  if (facts.timeline.kind === "unknown") facts.timeline.weeks = null;
  if (prior) {
    facts.callerName ??= prior.callerName ?? null;
    facts.phone ??= prior.phone ?? null;
    facts.location ??= prior.location;
    facts.sqft ??= prior.sqft;
    facts.rooms ??= prior.rooms;
    facts.currentState ??= prior.currentState;
    facts.budgetLakh ??= prior.budgetLakh;
    if (facts.serviceType === "unknown") facts.serviceType = prior.serviceType;
    if (facts.intent === "unclear") facts.intent = prior.intent;
    if (facts.timeline.kind === "unknown") facts.timeline = prior.timeline;
    if (facts.decisionMaker === "unknown") {
      facts.decisionMaker = prior.decisionMaker;
      facts.decisionMakerNote ??= prior.decisionMakerNote ?? null;
    }
    if (prior.existingClient) facts.existingClient = true;
  }
  return facts;
}
var EXTRACT_SYSTEM = `You read a phone conversation between a caller and the Aangan Studio interior design agent and record ONLY what the CALLER has actually said. Never infer, assume, or fill gaps; use null / "unknown" / "unclear" when the caller has not said it.
- existingClient: true ONLY if the caller already has a designer assigned or a project already under way with Aangan and is raising an issue about it. A caller chasing an earlier enquiry or a promised call-back, with no project under way, is a NEW enquiry: false.
- serviceType: full_home (whole home), partial_home (2+ rooms or a floor), single_room, commercial_office (office/clinic/studio), or an out-of-scope type (restaurant, hotel, retail, gym, architecture_structural, decor_only, furniture_only, vastu_only).
- intent: full_execution if they want design and execution done by the studio; advice_only if they only want ideas, advice, or will execute themselves; else unclear.
- timeline, weeks counted from today: kind start_by = the date execution (building work) must START; complete_by = the date the project must be FINISHED, or the caller must move in / be operational; flexible = no deadline; unknown = not stated. A date for starting DESIGN or a planning step is not an execution start: ignore it and use the move-in or finish date. If the caller first states a deadline and later floats a different date, keep the first stated deadline.
  Examples: "We move in November, so maybe starting design from October" -> complete_by (the move-in), NOT start_by. "I want it done before Diwali" when the conversation says Diwali is three weeks away -> complete_by, weeks 3. "We'd like to start execution in January" -> start_by. "Done by March, no rush" -> complete_by. If the conversation itself says how far away a date is (for example "Diwali is three weeks away"), use that figure instead of your own calendar knowledge; otherwise work it out from today's date.
- decisionMaker: self; authorised (spouse/partner who is not on the call has told them to go ahead); family_attending (e.g. parents who will attend the consultation and decide); research_only (just researching for someone else, no confirmation they will be involved); else unknown.
- budgetMinRupees / budgetMaxRupees: ONLY if the caller states a budget figure, as whole rupees (1 lakh = 100000, so "1 to 1.5 lakh" is 100000 and 150000; a single figure goes in both). Otherwise null. Use whole numbers for every number field.
Today is {TODAY}.`;
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
    budgetMinRupees: { type: "INTEGER", nullable: true },
    budgetMaxRupees: { type: "INTEGER", nullable: true }
  },
  required: ["existingClient", "serviceType", "intent", "timeline", "decisionMaker"]
};
var asText = (t) => t.map((x) => `${x.speaker === "agent" ? "Agent" : "Caller"}: ${x.text}`).join("\n");
var GeminiLlm = class {
  apiKey;
  model;
  fetchImpl;
  now;
  constructor(apiKey, model = DEFAULT_GEMINI_MODEL, fetchImpl = fetch, now2 = () => /* @__PURE__ */ new Date()) {
    this.apiKey = apiKey;
    this.model = model;
    this.fetchImpl = fetchImpl;
    this.now = now2;
  }
  async generate(system, user, schema) {
    let lastReason = "";
    const total = { inputTokens: 0, outputTokens: 0 };
    for (let attempt = 0; attempt < 2; attempt++) {
      const res = await this.fetchImpl(`https://generativelanguage.googleapis.com/v1beta/models/${this.model}:generateContent`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": this.apiKey },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: system }] },
          contents: [{ role: "user", parts: [{ text: user }] }],
          // "minimal" switches off hidden reasoning: it cost about 4x more per call and is not needed for reading facts.
          generationConfig: { temperature: 0, maxOutputTokens: 1024, responseMimeType: "application/json", responseSchema: schema, thinkingConfig: { thinkingLevel: "minimal" } }
        })
      });
      if (!res.ok) throw new Error(`Gemini ${this.model} -> ${res.status}: ${await res.text()}`);
      const body = await res.json();
      const u = body.usageMetadata ?? {};
      total.inputTokens += u.promptTokenCount ?? 0;
      total.outputTokens += (u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0);
      const text = body.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
      lastReason = body.candidates?.[0]?.finishReason ?? "no candidate";
      try {
        const parsed = JSON.parse(text);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return { json: parsed, usage: total };
      } catch {
      }
    }
    throw new Error(`Gemini returned no usable JSON (finishReason ${lastReason})`);
  }
  async triage(utterance) {
    const { json: json2, usage } = await this.generate(
      "Classify one caller utterance to an interior design studio. route=faq ONLY if it is a general question about what the studio does, where it works, how long projects take, commercial size limits, what it does not do, or rented flats, with no details about the caller's own project. Anything about the caller's own project or situation is route=qualify.",
      utterance,
      { type: "OBJECT", properties: { route: { type: "STRING", enum: ["faq", "qualify"] }, topic: { type: "STRING", enum: FAQ_TOPICS } }, required: ["route"] }
    );
    const topic = pick(json2.topic, FAQ_TOPICS, "services");
    return json2.route === "faq" ? { route: "faq", topic, usage } : { route: "qualify", usage };
  }
  async extractFacts(transcript, prior) {
    const { json: json2, usage } = await this.generate(
      EXTRACT_SYSTEM.replace("{TODAY}", this.now().toISOString().slice(0, 10)),
      asText(transcript),
      EXTRACT_SCHEMA
    );
    return { facts: normaliseFacts(json2, prior), usage };
  }
  async chooseSlot(utterance, slots) {
    const { json: json2, usage } = await this.generate(
      "The agent offered the caller numbered appointment slots. Decide which one the caller chose (1-based), or whether they declined all of them. If unclear, return choice 0 and declined false.",
      `Slots: ${slots.map((s, i) => `${i + 1}. ${s.label}`).join("; ")}
Caller: ${utterance}`,
      { type: "OBJECT", properties: { choice: { type: "INTEGER" }, declined: { type: "BOOLEAN" } }, required: ["choice", "declined"] }
    );
    const c = num(json2.choice);
    const index = c !== null && c >= 1 && c <= slots.length ? c - 1 : null;
    return { index, declined: json2.declined === true, usage };
  }
};

// src/integrations/hubspot.ts
var HubSpotCrm = class {
  token;
  pipeline;
  stage;
  fetchImpl;
  constructor(token, opts = {}, fetchImpl = fetch) {
    this.token = token;
    this.pipeline = opts.pipeline ?? "default";
    this.stage = opts.stage ?? "appointmentscheduled";
    this.fetchImpl = fetchImpl;
  }
  async call(method, path, body) {
    const res = await this.fetchImpl(`https://api.hubapi.com${path}`, {
      method,
      headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : void 0
    });
    if (!res.ok) throw new Error(`HubSpot ${method} ${path} -> ${res.status}: ${await res.text()}`);
    return res.json();
  }
  async createDeal(a) {
    let contactId = null;
    if (a.phone || a.contactName) {
      try {
        const [first, ...rest] = (a.contactName ?? "Unknown caller").split(" ");
        const c = await this.call("POST", "/crm/v3/objects/contacts", {
          properties: { firstname: first, lastname: rest.join(" ") || void 0, phone: a.phone ?? void 0 }
        });
        contactId = String(c.id);
      } catch {
      }
    }
    const deal = await this.call("POST", "/crm/v3/objects/deals", {
      properties: { dealname: a.dealName, pipeline: this.pipeline, dealstage: this.stage, description: a.note }
    });
    const dealId = String(deal.id);
    if (contactId) {
      try {
        await this.call("PUT", `/crm/v4/objects/deals/${dealId}/associations/default/contacts/${contactId}`);
      } catch {
      }
    }
    return { dealId };
  }
};

// src/integrations/mock.ts
import { randomUUID as randomUUID2 } from "node:crypto";
var ZERO = { inputTokens: 0, outputTokens: 0 };
var MockLlm = class {
  async triage(u) {
    const t = u.toLowerCase();
    const topic = [
      [/what (do|does) (you|aangan)|what services/, "services"],
      [/which areas|where do you work|do you (work|serve|cover)/, "service_area"],
      [/how long|how many weeks|timeline for/, "timelines"],
      [/offices?|commercial/, "commercial"],
      [/don'?t do|not do|restaurant|hotel/, "not_offered"],
      [/rented|tenant/, "rented"]
    ];
    const general = /^(what|which|how long|do you|does aangan|can you tell me what)/.test(t) && !/\b(my|our|i have|we have|i'm|we're)\b/.test(t);
    const hit = general ? topic.find(([re]) => re.test(t)) : void 0;
    return hit ? { route: "faq", topic: hit[1], usage: ZERO } : { route: "qualify", usage: ZERO };
  }
  async extractFacts(transcript, prior) {
    const caller = transcript.filter((x) => x.speaker === "caller").map((x) => x.text).join(" ");
    const t = caller.toLowerCase();
    const raw = {};
    const loc = t.match(/\b(kothrud|baner|aundh|wakad|koregaon park|kalyani nagar|viman nagar|hadapsar|magarpatta|nibm|kondhwa|undri|warje|deccan|pimple saudagar|ravet|hinjewadi|kharadi|nashik|mumbai|talegaon|lonavala)\b/);
    if (loc) raw.location = loc[1];
    const sq = t.match(/([\d,]{3,6})\s*(?:sq\.?\s*ft|square feet|sqft)/);
    if (sq) raw.sqft = Number(sq[1].replace(/,/g, ""));
    raw.existingClient = /my designer|my project has been going|already (have|has) a designer/.test(t);
    if (/restaurant/.test(t)) raw.serviceType = "restaurant";
    else if (/\bgym\b/.test(t)) raw.serviceType = "gym";
    else if (/office|clinic/.test(t)) raw.serviceType = "commercial_office";
    else if (/3bhk|4bhk|2bhk|whole|full (home|flat)|complete redesign/.test(t)) raw.serviceType = "full_home";
    if (/just (looking for )?ideas|only (need )?(advice|suggestions)|just exploring/.test(t)) raw.intent = "advice_only";
    else if (/full (redesign|home|execution)|complete redesign|design and execution|redo the whole/.test(t)) raw.intent = "full_execution";
    const wk = t.match(/(\d+)\s*weeks?/);
    if (wk) raw.timeline = { kind: "complete_by", weeks: Number(wk[1]) };
    else if (/no rush|flexible|plenty of time/.test(t)) raw.timeline = { kind: "flexible", weeks: null };
    if (/\b(i|myself)\b.*\b(decide|owner)\b|i am the owner|yes,? (i am|me)/.test(t)) raw.decisionMaker = "self";
    return { facts: normaliseFacts(raw, prior), usage: ZERO };
  }
  async chooseSlot(u, slots) {
    const t = u.toLowerCase();
    if (/\b(no|not now|don'?t|later)\b/.test(t)) return { index: null, declined: true, usage: ZERO };
    if (/\b(first|1|one|earlier)\b/.test(t)) return { index: 0, declined: false, usage: ZERO };
    if (/\b(second|2|two|later one)\b/.test(t) && slots.length > 1) return { index: 1, declined: false, usage: ZERO };
    return { index: null, declined: false, usage: ZERO };
  }
};
var MockCalendar = class {
  booked = [];
  failNext = false;
  async findSlots(count, after) {
    const out = [];
    const d = new Date(after);
    for (let i = 1; out.length < count && i < 15; i++) {
      const day = new Date(d.getTime() + i * 864e5);
      const dow = new Date(day.getTime() + 330 * 6e4).getUTCDay();
      if (dow === 0 || dow === 6) continue;
      const hh = out.length % 2 === 0 ? 11 : 16;
      const start = new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), hh - 6, 30)).toISOString();
      if (this.booked.some((b) => b.slot.start === start)) continue;
      out.push({ start, label: slotLabel(start) });
    }
    return out;
  }
  async book(a) {
    if (this.failNext) {
      this.failNext = false;
      throw new Error("mock calendar failure");
    }
    const ref = "mock-" + randomUUID2().slice(0, 8);
    this.booked.push({ ...a, ref });
    return { ref, start: a.slot.start };
  }
};
var MockNotifier = class {
  sent = [];
  fail = false;
  async send(channel, text) {
    if (this.fail) throw new Error("mock telegram failure");
    this.sent.push({ channel, text });
    return { messageId: String(this.sent.length) };
  }
};
var MockCrm = class {
  deals = [];
  fail = false;
  async createDeal(a) {
    if (this.fail) throw new Error("mock hubspot failure");
    const dealId = "deal-" + (this.deals.length + 1);
    this.deals.push({ ...a, dealId });
    return { dealId };
  }
};

// src/integrations/telegram.ts
var TelegramNotifier = class {
  token;
  chats;
  fetchImpl;
  constructor(token, designersChatId, seniorChatId, fetchImpl = fetch) {
    this.token = token;
    this.chats = { designers: designersChatId, senior: seniorChatId || designersChatId };
    this.fetchImpl = fetchImpl;
  }
  async send(channel, text) {
    const res = await this.fetchImpl(`https://api.telegram.org/bot${this.token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: this.chats[channel], text, disable_web_page_preview: true })
    });
    const body = await res.json();
    if (!res.ok || !body.ok) throw new Error(`Telegram sendMessage failed: ${res.status} ${body.description ?? ""}`);
    return { messageId: String(body.result.message_id) };
  }
};

// src/integrations/index.ts
function createIntegrations(env = process.env) {
  const mocked = [];
  const llm = env.GEMINI_API_KEY ? new GeminiLlm(env.GEMINI_API_KEY, env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL) : (mocked.push("gemini"), new MockLlm());
  const calendar = env.CALCOM_API_KEY && env.CALCOM_EVENT_TYPE_ID ? new CalComCalendar(env.CALCOM_API_KEY, Number(env.CALCOM_EVENT_TYPE_ID), env.CALCOM_EMAIL_FALLBACK) : (mocked.push("calcom"), new MockCalendar());
  const notifier = env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_DESIGNER_CHAT_ID ? new TelegramNotifier(env.TELEGRAM_BOT_TOKEN, env.TELEGRAM_DESIGNER_CHAT_ID, env.TELEGRAM_SENIOR_CHAT_ID) : (mocked.push("telegram"), new MockNotifier());
  const crm = env.HUBSPOT_TOKEN ? new HubSpotCrm(env.HUBSPOT_TOKEN, { pipeline: env.HUBSPOT_PIPELINE, stage: env.HUBSPOT_DEAL_STAGE }) : (mocked.push("hubspot"), new MockCrm());
  return { llm, calendar, notifier, crm, mocked };
}

// src/voice/http.ts
import { timingSafeEqual as timingSafeEqual2 } from "node:crypto";

// src/core/handoff.ts
function buildHandoffNote(f2, d, booking) {
  const budget = f2.budgetLakh ? `Rs ${f2.budgetLakh.min}-${f2.budgetLakh.max} lakh volunteered` + (d.flags.some((x) => x.includes("budget")) ? " (BORDERLINE)" : "") : "None volunteered";
  const dm = {
    self: "Direct (caller decides)",
    authorised: "Represented (caller authorised by partner)",
    family_attending: "Represented (family will attend and decide)",
    research_only: "UNCLEAR: caller is researching for someone else",
    unknown: "UNCLEAR: not confirmed"
  };
  const t = f2.timeline;
  const timeline = t.kind === "flexible" ? "Flexible" : t.kind === "unknown" || t.weeks === null ? "Not stated" : `${t.kind === "start_by" ? "Start" : "Complete"} within ~${t.weeks} weeks`;
  return [
    `NEW QUALIFIED LEAD`,
    `Caller: ${f2.callerName ?? "(name not given)"} | ${f2.phone ?? "(phone not captured)"}`,
    `Project: ${f2.serviceType.replace(/_/g, " ")} | ${f2.location ?? "location unknown"} | ${f2.sqft ? f2.sqft + " sq ft" : "size not given"}`,
    `Current state of space: ${f2.currentState ?? "not stated"}`,
    `Timeline: ${timeline}`,
    `Budget signal: ${budget}`,
    `Decision-maker: ${dm[f2.decisionMaker]}${f2.decisionMakerNote ? " \u2014 " + f2.decisionMakerNote : ""}`,
    `Uncertainty flags: ${d.flags.length ? d.flags.join("; ") : "none"}`,
    `Consultation booked: ${booking.booked ? "YES" + (booking.when ? " \u2014 " + booking.when : "") : "no"}`,
    ...!booking.booked && booking.suggested?.length ? [`Free slots to offer the caller: ${booking.suggested.join(" | ")}`] : []
  ].join("\n");
}

// src/core/pricing.ts
var ASKING_PRICE = [
  /\b(how much|what(?:'s| is| would| will)? (?:the )?(?:cost|price|rate|charge))/i,
  /\b(costs?|prices?|pricing|rates?|charges?|quotes?|quotation|ballpark|estimates?|price list)\b/i,
  /\bper\s*(?:sq\.?\s*ft|square\s*f(?:oo|ee)t|sqft)\b/i,
  /\b(kitna|kitne|kharcha|kharch|daam|bhav)\b/i,
  // Hindi / Hinglish
  /\bhow expensive\b/i,
  // Follow-ups that never repeat the word "cost": "just a rough range", "even a number".
  /\bballpark\b/i,
  /\brough(ly)?\s+(\w+\s+){0,2}(range|figure|number|idea|estimate|amount|cost|price)\b/i,
  /\b(give|even|just|any|some|tell)\s+(me\s+)?(a\s+|an\s+|any\s+|some\s+)?(range|figure|number|estimate)\b/i,
  /\b(starting|starts?)\s+(price|from|at)\b/i,
  /\bwhat('?s| is) (it|that) (going to|gonna)?\s*(come to|run to|be)\b.*\?/i
];
var VOLUNTEERING_BUDGET = /\b(my|our)\s+budget\b|\bbudget\s+(is|of|around|max)/i;
function isPricingQuestion(utterance) {
  if (VOLUNTEERING_BUDGET.test(utterance) && !/\?/.test(utterance)) return false;
  return ASKING_PRICE.some((re) => re.test(utterance));
}
var MONEY_IN_SPEECH = [
  /(?:₹|\brs\.?|\binr)\s*\d/i,
  /\d[\d,.]*\s*(?:lakh|lac|lakhs|crore|cr)\b/i
];
var RATE_PHRASES_IN_SPEECH = [
  /\bper\s*(?:sq\.?\s*ft|square\s*f(?:oo|ee)t|sqft)\b/i,
  /\/\s*(?:sq\.?\s*ft|sqft)\b/i,
  /\b(?:it'?ll|it will) cost\b/i,
  /\brates? start\b/i,
  /\btypically\b.*\b(?:₹|rs|lakh)/i
];
function violatesPricingRule(speech) {
  return MONEY_IN_SPEECH.some((re) => re.test(speech)) || RATE_PHRASES_IN_SPEECH.some((re) => re.test(speech));
}
function pricingViolationKind(speech) {
  if (RATE_PHRASES_IN_SPEECH.some((re) => re.test(speech))) return "phrase";
  return MONEY_IN_SPEECH.some((re) => re.test(speech)) ? "money" : null;
}
function guardSpeech(speech) {
  return violatesPricingRule(speech) ? { text: PRICING_DEFLECTION, replaced: true } : { text: speech, replaced: false };
}
function pricingResponse() {
  return PRICING_DEFLECTION;
}

// src/core/audit.ts
var expand = (s) => s.replace(/\b(\w+)'d\b/gi, "$1 would").replace(/\b(\w+)'ll\b/gi, "$1 will").replace(/\b(\w+)n't\b/gi, "$1 not").replace(/\b(\w+)'re\b/gi, "$1 are").replace(/\b(\w+)'ve\b/gi, "$1 have");
var normalise = (s) => expand(s.replace(/[\u2018\u2019]/g, "'")).toLowerCase().replace(/[—–\-]+/g, " ").replace(/[‘’']/g, "'").replace(/[^\p{L}\p{N}' ]/gu, " ").replace(/\s+/g, " ").trim();
var numbersIn = (s) => (s.match(/\d[\d,]*\.?\d*/g) ?? []).map((n) => n.replace(/,/g, ""));
function quotesPrice(turns, i) {
  const t = turns[i];
  if (t.speaker !== "agent") return false;
  const kind = pricingViolationKind(t.text);
  if (kind === null) return false;
  if (kind === "phrase") return true;
  const nums = numbersIn(t.text);
  if (!nums.length) return true;
  const callerSaid = new Set(turns.slice(0, i).filter((x) => x.speaker === "caller").flatMap((x) => numbersIn(x.text)));
  return !nums.every((n) => callerSaid.has(n));
}
function auditAgentTurns(turns, ctx) {
  const agent = turns.filter((t) => t.speaker === "agent").map((t) => normalise(t.text));
  const issues = [];
  if (turns.some((_, i) => quotesPrice(turns, i))) issues.push("price_quoted");
  const pricingAsked = turns.some((t) => t.speaker === "caller" && isPricingQuestion(t.text));
  if (pricingAsked && !agent.some((a) => a.includes(normalise(PRICING_DEFLECTION)))) issues.push("pricing_line_not_verbatim");
  if (ctx.verdict === "declined" && !agent.some((a) => a.includes(normalise(DECLINE_SCRIPT)))) issues.push("decline_line_not_verbatim");
  return issues;
}
var ISSUE_TEXT = {
  price_quoted: "Agent stated a price, range or per-sq-ft figure",
  pricing_line_not_verbatim: "Caller asked about price and the agent did not use the scripted line",
  decline_line_not_verbatim: "Call was declined but the agent did not use the scripted decline line",
  booked_despite_verdict: "A consultation was booked on a call the rules say should not have been forwarded"
};

// src/session/post-call.ts
async function completeCall(d, rec, o) {
  if (rec.verdict !== "in_progress") return rec;
  const rates = d.rates ?? DEFAULT_RATES;
  const costs = [vaaniCost(o.durationSec, rates)];
  if (o.usage.inputTokens || o.usage.outputTokens) costs.push(...geminiCost(o.usage.inputTokens, o.usage.outputTokens, rates));
  for (let i = 0; i < o.calendarCalls; i++) costs.push(calcomCost(rates));
  const dec = o.decision;
  let handoff;
  let crm;
  if (dec?.verdict === "qualified" && o.facts) {
    let suggested;
    if (o.booking.status !== "booked") {
      try {
        suggested = (await d.calendar.findSlots(3, /* @__PURE__ */ new Date())).map((x) => x.label);
        costs.push(calcomCost(rates));
      } catch {
      }
    }
    const note = buildHandoffNote(o.facts, dec, {
      booked: o.booking.status === "booked",
      suggested,
      when: o.booking.time ? new Date(o.booking.time).toLocaleString("en-IN", { dateStyle: "full", timeStyle: "short", timeZone: "Asia/Kolkata" }) : void 0
    });
    try {
      await d.notifier.send("designers", note);
      costs.push(telegramCost(rates));
      handoff = { status: "sent" };
    } catch {
      handoff = { status: "failed" };
    }
    try {
      const deal = await d.crm.createDeal({
        dealName: `${o.facts.callerName ?? "Phone enquiry"} \u2014 ${o.facts.location ?? "Pune"} ${o.facts.serviceType.replace(/_/g, " ")}`,
        contactName: o.facts.callerName ?? null,
        phone: o.facts.phone ?? rec.callerPhone ?? null,
        note
      });
      costs.push(hubspotCost(rates));
      crm = { status: "created", dealId: deal.dealId };
    } catch {
      crm = { status: "failed" };
    }
  } else if (dec?.verdict === "escalated") {
    const already = rec.handoffStatus === "escalation_pending";
    if (already) handoff = { status: "escalation_pending" };
    else {
      const lines = o.transcript.filter((t) => t.speaker === "caller").map((t) => `- ${t.text}`).join("\n");
      const msg = `URGENT: existing-client issue. Senior callback needed within 15 minutes.
Caller: ${o.facts?.callerName ?? "(name not given)"} | ${o.facts?.phone ?? rec.callerPhone ?? "(phone not captured)"}
What they said:
${lines}`;
      try {
        await d.notifier.send("senior", msg);
        costs.push(telegramCost(rates));
        handoff = { status: "escalation_pending" };
      } catch {
        handoff = { status: "failed" };
      }
    }
  }
  if (o.audit && o.audit.length) {
    try {
      await d.notifier.send("senior", `SCRIPT BREACH on a call (${rec.id.slice(0, 8)}):
- ${o.audit.map((i) => ISSUE_TEXT[i]).join("\n- ")}
Caller: ${o.facts?.callerName ?? "(name not given)"} | ${o.facts?.phone ?? rec.callerPhone ?? "(phone not captured)"}`);
      costs.push(telegramCost(rates));
    } catch {
    }
  }
  return finishCall(d.repo, rec.id, {
    decision: dec,
    facts: o.facts,
    transcript: o.transcript,
    endedAt: o.endedAt,
    durationSec: o.durationSec,
    pricingAsked: o.pricingAsked,
    booking: dec?.verdict === "qualified" ? o.booking : void 0,
    handoff,
    crm,
    costs,
    auditIssues: o.audit ?? null
  });
}

// src/session/call-session.ts
var MAX_CALLER_TURNS = 25;
var SAY = {
  offer: (a, b) => b ? `Wonderful \u2014 I can book your consultation right now. I have ${a.label}, or ${b.label}. Which works better for you?` : `Wonderful \u2014 I can book your consultation right now. I have ${a.label}. Does that work for you?`,
  reoffer: "Sorry, I didn't catch which one \u2014 could you tell me which slot you'd prefer?",
  booked: (label) => `You're booked for ${label}. Your designer will already have everything you've told me. Thank you for calling Aangan Studio.`,
  noBooking: "No problem. Your designer will have everything you've told me and will reach out to arrange a time. Thank you for calling Aangan Studio.",
  bookingFailed: "I'm sorry, I couldn't confirm the slot just now. Your designer will have everything you've told me and will call you to confirm a time. Thank you for calling Aangan Studio.",
  tooLong: "Thank you for the details. Your designer will have everything you've told me and will be in touch. Thank you for calling Aangan Studio."
};
var ist = (d) => new Date(d.getTime() + 330 * 6e4);
var CallSession = class _CallSession {
  d;
  rec;
  transcript = [];
  facts = null;
  asked = {};
  decision = null;
  phase = "qualifying";
  slots = [];
  slotRetries = 0;
  callerTurns = 0;
  pricingAsked = false;
  usage = { inputTokens: 0, outputTokens: 0 };
  booking = { status: "not_applicable" };
  calendarCalls = 0;
  lastQuestionCriterion = null;
  constructor(d, rec) {
    this.d = d;
    this.rec = rec;
  }
  static async start(d, a) {
    const rec = await startCall(d.repo, a);
    const s = new _CallSession(d, rec);
    const greeting = openingLine(ist(new Date(a.startedAt)).getUTCHours());
    s.say(greeting);
    await s.persist();
    return { session: s, greeting };
  }
  // Rebuild a session from the database so any server instance can take the
  // next turn of a call in progress.
  static resume(d, rec) {
    const s = new _CallSession(d, rec);
    s.transcript = [...rec.transcript];
    const st = rec.sessionState;
    if (st) {
      s.facts = st.facts;
      s.asked = st.asked;
      s.decision = st.decision;
      s.phase = st.phase;
      s.slots = st.slots;
      s.slotRetries = st.slotRetries;
      s.callerTurns = st.callerTurns;
      s.pricingAsked = st.pricingAsked;
      s.usage = st.usage;
      s.booking = st.booking;
      s.calendarCalls = st.calendarCalls;
      s.lastQuestionCriterion = st.lastQuestionCriterion;
    }
    if (rec.verdict !== "in_progress") s.phase = "closed";
    return s;
  }
  snapshot() {
    return {
      facts: this.facts,
      asked: this.asked,
      decision: this.decision,
      phase: this.phase,
      slots: this.slots,
      slotRetries: this.slotRetries,
      callerTurns: this.callerTurns,
      pricingAsked: this.pricingAsked,
      usage: this.usage,
      booking: this.booking,
      calendarCalls: this.calendarCalls,
      lastQuestionCriterion: this.lastQuestionCriterion
    };
  }
  // Write the in-call state after every turn. If this server dies, the next
  // turn (or the end-of-call webhook) resumes from here.
  async persist() {
    this.rec = await this.d.repo.updateCall(this.rec.id, {
      transcript: this.transcript,
      facts: this.facts,
      sessionState: this.snapshot()
    });
  }
  get callId() {
    return this.rec.id;
  }
  get ended() {
    return this.phase === "closed";
  }
  now() {
    return (this.d.now ?? (() => /* @__PURE__ */ new Date()))();
  }
  addUsage(u) {
    this.usage.inputTokens += u.inputTokens;
    this.usage.outputTokens += u.outputTokens;
  }
  say(text) {
    const safe = guardSpeech(text).text;
    this.transcript.push({ speaker: "agent", text: safe, at: this.now().toISOString() });
    return safe;
  }
  // One caller utterance in, the agent's reply out. State is saved afterwards.
  async hear(utterance) {
    const r = await this.hearInner(utterance);
    await this.persist();
    return r;
  }
  async hearInner(utterance) {
    this.transcript.push({ speaker: "caller", text: utterance, at: this.now().toISOString() });
    this.callerTurns++;
    const reply = (text, end = false) => {
      if (end) this.phase = "closed";
      return { say: this.say(text), end };
    };
    if (this.phase === "offering_slots") return this.handleSlotChoice(utterance, reply);
    if (this.callerTurns > MAX_CALLER_TURNS) return reply(SAY.tooLong, true);
    const ex = await this.d.llm.extractFacts(this.transcript, this.facts);
    this.addUsage(ex.usage);
    this.facts = ex.facts;
    if (!this.facts.phone && this.rec.callerPhone) this.facts.phone = this.rec.callerPhone;
    const asking = isPricingQuestion(utterance);
    if (asking) this.pricingAsked = true;
    const askedNow = { ...this.asked };
    if (this.lastQuestionCriterion)
      askedNow[this.lastQuestionCriterion] = (askedNow[this.lastQuestionCriterion] ?? 0) + 1;
    const dec = evaluate(this.facts, askedNow, this.now());
    this.decision = dec;
    if (dec.verdict === "declined" || dec.verdict === "deferred" || dec.verdict === "escalated")
      return reply(dec.say, true);
    if (asking) return reply(pricingResponse());
    const tri = await this.d.llm.triage(utterance);
    this.addUsage(tri.usage);
    if (tri.route === "faq") return reply(FAQ_ANSWERS[tri.topic]);
    this.asked = askedNow;
    this.lastQuestionCriterion = null;
    if (dec.verdict === "needs_followup") {
      this.lastQuestionCriterion = dec.ask;
      return reply(dec.say);
    }
    return this.offerSlots(reply);
  }
  async offerSlots(reply) {
    try {
      this.calendarCalls++;
      this.slots = await this.d.calendar.findSlots(2, this.now());
    } catch {
      this.slots = [];
    }
    if (!this.slots.length) {
      this.booking = { status: "failed" };
      return reply(SAY.bookingFailed, true);
    }
    this.booking = { status: "offered" };
    this.phase = "offering_slots";
    return reply(SAY.offer(this.slots[0], this.slots[1]));
  }
  async handleSlotChoice(utterance, reply) {
    const c = await this.d.llm.chooseSlot(utterance, this.slots);
    this.addUsage(c.usage);
    if (c.declined) {
      this.booking = { status: "declined_by_caller" };
      return reply(SAY.noBooking, true);
    }
    if (c.index === null) {
      if (this.slotRetries++ < 1) return reply(SAY.reoffer);
      this.booking = { status: "declined_by_caller" };
      return reply(SAY.noBooking, true);
    }
    const slot = this.slots[c.index];
    try {
      this.calendarCalls++;
      const b = await this.d.calendar.book({
        slot,
        name: this.facts?.callerName ?? null,
        phone: this.facts?.phone ?? null,
        notes: buildHandoffNote(this.facts, this.decision, { booked: true, when: slot.label })
      });
      this.booking = { status: "booked", time: b.start, ref: b.ref };
      return reply(SAY.booked(slot.label), true);
    } catch {
      this.booking = { status: "failed" };
      return reply(SAY.bookingFailed, true);
    }
  }
  // Called on hang-up (or once the agent has ended the call).
  async finish(a) {
    this.phase = "closed";
    return completeCall(this.d, this.rec, {
      decision: this.decision,
      facts: this.facts,
      transcript: this.transcript,
      endedAt: a.endedAt,
      durationSec: a.durationSec,
      pricingAsked: this.pricingAsked,
      booking: this.booking,
      usage: this.usage,
      calendarCalls: this.calendarCalls
    });
  }
};

// src/voice/brain.ts
async function startCallHandler(d, a) {
  const { session, greeting } = await CallSession.start(d, {
    providerCallId: a.providerCallId,
    startedAt: a.startedAt ?? (d.now ?? (() => /* @__PURE__ */ new Date()))().toISOString(),
    answerLatencyMs: a.answerLatencyMs ?? null,
    callerPhone: a.callerPhone ?? null
  });
  return { callId: session.callId, say: greeting, end: false };
}
async function load(d, ref) {
  if (ref.providerCallId) return d.repo.getByProviderCallId(ref.providerCallId);
  return null;
}
async function turnHandler(d, a) {
  const rec = await load(d, a);
  if (!rec) throw new NotFound(`no call with provider id ${a.providerCallId}`);
  const s = CallSession.resume(d, rec);
  if (s.ended) return { callId: rec.id, say: "", end: true };
  const r = await s.hear(a.utterance);
  return { callId: rec.id, ...r };
}
async function endCallHandler(d, a) {
  const rec = await load(d, a);
  if (!rec) throw new NotFound(`no call with provider id ${a.providerCallId}`);
  const s = CallSession.resume(d, rec);
  return s.finish({ endedAt: a.endedAt ?? (d.now ?? (() => /* @__PURE__ */ new Date()))().toISOString(), durationSec: a.durationSec });
}
var NotFound = class extends Error {
};

// src/voice/tools.ts
var now = (d) => (d.now ?? (() => /* @__PURE__ */ new Date()))();
var str2 = (v) => typeof v === "string" && v.trim() ? v.trim() : null;
var num2 = (v) => typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() && Number.isFinite(Number(v)) ? Number(v) : null;
async function resolveCall(d, a) {
  const id = str2(a.callId), phone = str2(a.callerPhone);
  if (id) {
    const hit = await d.repo.getByProviderCallId(id);
    if (hit) return hit;
  }
  if (phone) {
    const since = new Date(now(d).getTime() - 3 * 36e5).toISOString();
    const open = (await d.repo.listCalls({ from: since, to: new Date(now(d).getTime() + 6e4).toISOString() })).filter((c) => c.verdict === "in_progress" && c.callerPhone === phone);
    if (open.length) return open[0];
  }
  return startCall(d.repo, { providerCallId: id ?? void 0, startedAt: now(d).toISOString(), answerLatencyMs: null, callerPhone: phone });
}
var ASK_NAMES = {
  c1: "c1",
  c2: "c2",
  c3: "c3",
  c4: "c4",
  c5: "c5",
  project: "c1",
  real_project: "c1",
  location: "c2",
  area: "c2",
  timeline: "c3",
  budget: "c4",
  decision_maker: "c5",
  decision: "c5"
};
async function qualifyTool(d, b) {
  const rec = await resolveCall(d, b);
  const prior = rec.facts;
  const facts = normaliseFacts({
    callerName: b.callerName,
    phone: b.callerPhone ?? rec.callerPhone,
    existingClient: b.existingClient === true || b.existingClient === "true",
    serviceType: b.serviceType,
    intent: b.intent,
    location: b.location,
    sqft: num2(b.sqft),
    rooms: num2(b.rooms),
    currentState: b.currentState,
    timeline: { kind: b.timelineKind, weeks: num2(b.timelineWeeks) },
    decisionMaker: b.decisionMaker,
    decisionMakerNote: b.decisionMakerNote,
    budgetMinRupees: num2(b.budgetMinRupees),
    budgetMaxRupees: num2(b.budgetMaxRupees)
  }, prior);
  const asked = {};
  const askedList = Array.isArray(b.alreadyAsked) ? b.alreadyAsked : typeof b.alreadyAsked === "string" ? b.alreadyAsked.split(/[,;]/) : [];
  for (const x of askedList.map((y) => String(y).trim())) {
    const c = ASK_NAMES[String(x).toLowerCase()];
    if (c) asked[c] = (asked[c] ?? 0) + 1;
  }
  const dec = evaluate(facts, asked, now(d));
  const patch = { facts, callerName: facts.callerName ?? rec.callerName, callerPhone: facts.phone ?? rec.callerPhone };
  if (dec.verdict === "escalated" && rec.handoffStatus !== "escalation_pending") {
    try {
      await d.notifier.send("senior", `URGENT: existing-client issue. Senior callback needed within 15 minutes.
Caller: ${facts.callerName ?? "(name not given)"} | ${facts.phone ?? rec.callerPhone ?? "(phone not captured)"}
(Call still in progress.)`);
      patch.handoffStatus = "escalation_pending";
      await d.repo.addCosts(rec.id, [telegramCost(d.rates)]);
    } catch {
    }
  }
  await d.repo.updateCall(rec.id, patch);
  const next = {
    needs_followup: "Ask the caller this question, in your own natural words only if you keep its meaning: ",
    declined: "Say exactly this, word for word, then end the call politely: ",
    deferred: "Say exactly this, word for word: ",
    escalated: "Say exactly this, word for word. The senior team has already been alerted: ",
    qualified: "The caller qualifies. Call check_availability and offer the slots. "
  };
  return {
    callId: rec.providerCallId ?? rec.id,
    verdict: dec.verdict,
    say: dec.say,
    ask: dec.ask ?? null,
    flags: dec.flags,
    earliestStart: dec.earliestStart ?? null,
    instruction: next[dec.verdict] + (dec.say ?? "")
  };
}
async function availabilityTool(d, b) {
  const rec = await resolveCall(d, b);
  try {
    const slots = await d.calendar.findSlots(2, now(d));
    await d.repo.addCosts(rec.id, [calcomCost(d.rates)]);
    return { callId: rec.providerCallId ?? rec.id, slots, say: slots.length ? null : "No consultation slots are free right now. Tell the caller their designer will call to arrange a time." };
  } catch {
    return { callId: rec.providerCallId ?? rec.id, slots: [], say: "The calendar is unavailable. Tell the caller their designer will call to arrange a time." };
  }
}
async function bookTool(d, b) {
  const rec = await resolveCall(d, b);
  const start = str2(b.slotStart);
  if (!start) return { confirmed: false, say: "No slot was chosen. Ask the caller which slot they prefer." };
  const facts = rec.facts;
  const name = str2(b.callerName) ?? facts?.callerName ?? null, phone = str2(b.callerPhone) ?? facts?.phone ?? rec.callerPhone;
  try {
    const label = new Date(start).toLocaleString("en-IN", { weekday: "long", day: "numeric", month: "long", hour: "numeric", minute: "2-digit", hour12: true, timeZone: "Asia/Kolkata" });
    const booked = await d.calendar.book({
      slot: { start, label },
      name,
      phone,
      notes: facts ? buildHandoffNote(facts, evaluate(facts, { c1: 2, c2: 2, c3: 2, c5: 2 }, now(d)), { booked: true, when: label }) : str2(b.notes) ?? "Booked by phone agent"
    });
    await d.repo.addCosts(rec.id, [calcomCost(d.rates)]);
    await d.repo.updateCall(rec.id, { bookingStatus: "booked", bookingTime: booked.start, bookingRef: booked.ref, callerName: name ?? void 0, callerPhone: phone ?? void 0 });
    return { confirmed: true, bookingRef: booked.ref, start: booked.start, say: `The consultation is booked for ${label}. Confirm this to the caller and tell them their designer will already have everything they have said.` };
  } catch {
    await d.repo.updateCall(rec.id, { bookingStatus: "failed" });
    return { confirmed: false, say: "The booking did not go through. Tell the caller their designer will call them to confirm a time. Do not say it is booked." };
  }
}

// src/voice/vaani-webhook.ts
import { createHmac, timingSafeEqual } from "node:crypto";

// src/session/judge.ts
async function judgeConversation(llm, turns, today, prior = null) {
  const usage = { inputTokens: 0, outputTokens: 0 };
  const callerIdx = turns.map((t, i) => t.speaker === "caller" ? i : -1).filter((i) => i >= 0);
  const asked = {};
  let facts = prior;
  let decision = null;
  let reads = 0, turnsUsed = 0;
  for (const idx of callerIdx) {
    const r = await llm.extractFacts(turns.slice(0, idx + 1), facts);
    usage.inputTokens += r.usage.inputTokens;
    usage.outputTokens += r.usage.outputTokens;
    reads++;
    turnsUsed++;
    facts = r.facts;
    decision = evaluate(facts, asked, today);
    if (decision.verdict === "needs_followup") {
      asked[decision.ask] = (asked[decision.ask] ?? 0) + 1;
      continue;
    }
    if (decision.verdict !== "qualified") break;
  }
  for (let i = 0; i < 12 && facts && decision && decision.verdict === "needs_followup"; i++) {
    asked[decision.ask] = (asked[decision.ask] ?? 0) + 1;
    decision = evaluate(facts, asked, today);
  }
  return { facts, decision, usage, reads, turnsUsed };
}

// src/voice/finalize.ts
var MIN = 6e4;
async function matchOpenCall(d, a) {
  const from = new Date(new Date(a.startedAt).getTime() - 10 * MIN).toISOString();
  const to = new Date(new Date(a.endedAt).getTime() + 2 * MIN).toISOString();
  const open = (await d.repo.listCalls({ from, to })).filter((c) => c.verdict === "in_progress" && !c.sessionState);
  return open.length === 1 ? open[0] : null;
}
async function finalizeCall(d, f2) {
  let rec = await d.repo.getByProviderCallId(f2.providerCallId) ?? await matchOpenCall(d, f2);
  if (!rec) rec = await startCall(d.repo, { providerCallId: f2.providerCallId, startedAt: f2.startedAt, answerLatencyMs: null });
  if (rec.providerCallId !== f2.providerCallId && !rec.providerCallId) rec = await d.repo.updateCall(rec.id, { providerCallId: f2.providerCallId });
  if (rec.verdict !== "in_progress") return rec;
  const today = new Date(f2.startedAt);
  let decision = null;
  let facts = rec.facts;
  let usage = { inputTokens: 0, outputTokens: 0 };
  let audit = null;
  const turns = f2.transcript && f2.transcript.length ? f2.transcript : null;
  if (turns) {
    const j = await judgeConversation(d.llm, turns, today, rec.facts);
    facts = j.facts;
    decision = j.decision;
    usage = j.usage;
  } else if (rec.facts) {
    decision = evaluate(rec.facts, { c1: 2, c2: 2, c3: 2, c5: 2 }, today);
  }
  if (turns) {
    audit = auditAgentTurns(turns, { verdict: decision?.verdict ?? "abandoned" });
    if (rec.bookingStatus === "booked" && decision && decision.verdict !== "qualified") audit.push("booked_despite_verdict");
  }
  const reasonless = !decision;
  const done = await completeCall(d, rec, {
    decision,
    facts,
    transcript: turns ?? rec.transcript,
    endedAt: f2.endedAt,
    durationSec: f2.durationSec,
    pricingAsked: turns ? turns.some((t) => t.speaker === "caller" && isPricingQuestion(t.text)) : rec.pricingAsked,
    booking: { status: rec.bookingStatus === "not_applicable" ? "offered" : rec.bookingStatus, time: rec.bookingTime ?? void 0, ref: rec.bookingRef ?? void 0 },
    usage,
    calendarCalls: 0,
    audit
  });
  if (reasonless) await d.repo.updateCall(done.id, { reasons: [turns ? "no caller speech in the transcript" : "call ended with no transcript and no tool activity"] });
  return done;
}

// src/voice/vaani-webhook.ts
function verifySignature(rawBody, header, secret) {
  if (!secret || !header || !header.startsWith("sha256=")) return false;
  const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
  const got = header.slice("sha256=".length);
  const a = Buffer.from(expected, "utf8"), b = Buffer.from(got, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}
var firstString = (o, keys) => {
  for (const k of keys) {
    const v = o[k];
    if (typeof v === "string" && v) return v;
    if (typeof v === "number") return String(v);
  }
  return null;
};
var firstNumber = (o, keys) => {
  for (const k of keys) {
    const v = o[k];
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (typeof v === "string" && v.trim() && Number.isFinite(Number(v))) return Number(v);
  }
  return null;
};
function parseCallEvent(data, createdUnix) {
  const providerCallId = firstString(data, ["call_id", "callId", "session_id", "sessionId", "id"]);
  const ms = firstNumber(data, ["duration_ms", "durationMs"]);
  const durationSec = firstNumber(data, ["duration_sec", "duration_seconds", "durationSec", "duration"]) ?? (ms !== null ? ms / 1e3 : null);
  const startedRaw = data.started_at ?? data.startedAt ?? data.start_time;
  let startedAt = null;
  if (typeof startedRaw === "string" && !Number.isNaN(Date.parse(startedRaw))) startedAt = new Date(startedRaw).toISOString();
  else if (typeof startedRaw === "number") startedAt = new Date(startedRaw > 1e12 ? startedRaw : startedRaw * 1e3).toISOString();
  else if (durationSec !== null) startedAt = new Date((createdUnix - durationSec) * 1e3).toISOString();
  else startedAt = new Date(createdUnix * 1e3).toISOString();
  return { providerCallId, durationSec: durationSec !== null ? Math.round(durationSec) : null, startedAt };
}
var AGENT_ROLES = /* @__PURE__ */ new Set(["agent", "assistant", "ai", "bot", "vaani", "system", "model"]);
var CALLER_ROLES = /* @__PURE__ */ new Set(["caller", "user", "customer", "human", "client", "contact", "lead"]);
function parseTranscript(data) {
  const raw = data.transcript ?? data.transcripts ?? data.messages ?? data.conversation ?? data.turns;
  const at = (/* @__PURE__ */ new Date()).toISOString();
  const out = [];
  const push = (role, text) => {
    const r = String(role ?? "").toLowerCase().trim();
    const t = typeof text === "string" ? text.trim() : "";
    if (!t) return;
    if (AGENT_ROLES.has(r)) out.push({ speaker: "agent", text: t, at });
    else if (CALLER_ROLES.has(r)) out.push({ speaker: "caller", text: t, at });
  };
  if (Array.isArray(raw)) {
    for (const x of raw) if (x && typeof x === "object") {
      const o = x;
      push(o.role ?? o.speaker ?? o.from ?? o.sender, o.text ?? o.content ?? o.message ?? o.utterance);
    }
  } else if (typeof raw === "string") {
    for (const line of raw.split(/\r?\n/)) {
      const m = line.match(/^\s*(?:\[[^\]]*\]\s*)?([A-Za-z ]{2,12}):\s*(.*)$/);
      if (m && (AGENT_ROLES.has(m[1].toLowerCase().trim()) || CALLER_ROLES.has(m[1].toLowerCase().trim()))) push(m[1], m[2]);
      else if (out.length && line.trim()) out[out.length - 1].text += " " + line.trim();
    }
  }
  return out.length ? out : null;
}
async function handleVaaniWebhook(d, rawBody, signature, secret, opts = {}) {
  let peek = null;
  try {
    const j = JSON.parse(rawBody);
    peek = j && typeof j === "object" ? j : null;
  } catch {
  }
  if (peek && typeof peek.event === "string") return handleNativeEvent(d, peek, opts);
  if (!verifySignature(rawBody, signature, secret)) return { status: 401, body: { error: "bad signature" } };
  let env;
  try {
    env = JSON.parse(rawBody);
  } catch {
    return { status: 400, body: { error: "invalid json" } };
  }
  if (typeof env.id !== "string" || typeof env.type !== "string") return { status: 400, body: { error: "not a Vaani envelope" } };
  const fresh = await d.repo.recordProviderEvent({ id: env.id, type: env.type, payload: env });
  if (!fresh) return { status: 200, body: { duplicate: true } };
  if (env.type !== "call.completed" && env.type !== "call.failed") return { status: 200, body: { stored: true, handled: false } };
  const data = env.data && typeof env.data === "object" ? env.data : {};
  const created = typeof env.created === "number" ? env.created : Math.floor(Date.now() / 1e3);
  const ev = parseCallEvent(data, created);
  const failed = env.type === "call.failed";
  if (!ev.providerCallId) return { status: 200, body: { stored: true, handled: false, reason: "no call id in payload" } };
  const rec = await d.repo.getByProviderCallId(ev.providerCallId);
  const endedAt = new Date(created * 1e3).toISOString();
  if (rec?.sessionState) {
    const s = CallSession.resume(d, rec);
    const done2 = await s.finish({
      endedAt,
      durationSec: ev.durationSec ?? Math.max(0, Math.round((created * 1e3 - new Date(rec.startedAt).getTime()) / 1e3))
    });
    if (failed && done2.reasons.every((r) => !r.includes("pipeline"))) {
      await d.repo.updateCall(done2.id, { reasons: [...done2.reasons, "voice platform reported a pipeline error mid-call"] });
    }
    return { status: 200, body: { handled: true, callId: done2.id, verdict: done2.verdict } };
  }
  const transcript = parseTranscript(data);
  const durationSec = ev.durationSec ?? (rec ? Math.max(0, Math.round((created * 1e3 - new Date(rec.startedAt).getTime()) / 1e3)) : 0);
  const done = await finalizeCall(d, {
    providerCallId: ev.providerCallId,
    startedAt: rec?.startedAt ?? ev.startedAt,
    endedAt,
    durationSec,
    transcript
  });
  if (failed && done.reasons.every((r) => !r.includes("pipeline"))) {
    await d.repo.updateCall(done.id, { reasons: [...done.reasons, "voice platform reported a pipeline error mid-call"] });
  }
  return { status: 200, body: { handled: true, callId: done.id, verdict: done.verdict, transcript: Boolean(transcript) } };
}
var VAANI_API = "https://api.vaanivoice.ai";
async function fetchCallDetails(callId, apiKey, f2 = fetch) {
  const res = await f2(`${VAANI_API}/api/call_details/${encodeURIComponent(callId)}`, { headers: { "X-API-Key": apiKey } });
  if (res.status === 404) return { exists: false, transcription: null };
  if (!res.ok) throw new Error(`Vaani call_details -> ${res.status}`);
  const j = await res.json();
  const t = typeof j.transcription === "string" ? j.transcription : null;
  return { exists: true, transcription: t && !/not available for further evaluations/i.test(t) ? t : null };
}
async function handleNativeEvent(d, body, opts) {
  if (body.event !== "call_postprocessing") return { status: 200, body: { handled: false, reason: `ignored event ${String(body.event)}` } };
  const callId = typeof body.call_id === "string" && body.call_id ? body.call_id : null;
  if (!callId) return { status: 400, body: { error: "call_id is required" } };
  if (!opts.vaaniApiKey) return { status: 503, body: { error: "VAANI_API_KEY is not configured, so this event cannot be verified" } };
  let details;
  try {
    details = await fetchCallDetails(callId, opts.vaaniApiKey, opts.fetchImpl);
  } catch {
    return { status: 502, body: { error: "could not verify the call with Vaani; will accept a retry" } };
  }
  if (!details.exists) return { status: 404, body: { error: "unknown call" } };
  const fresh = await d.repo.recordProviderEvent({ id: `call_postprocessing:${callId}`, type: "call_postprocessing", payload: { call_id: callId } });
  if (!fresh) return { status: 200, body: { duplicate: true } };
  const data = body.data && typeof body.data === "object" ? body.data : {};
  const transcript = parseTranscript({ transcript: details.transcription ?? data.transcript });
  const ms = typeof data.call_duration === "number" ? data.call_duration : Number(data.call_duration);
  const durationSec = Number.isFinite(ms) && ms > 0 ? Math.round(ms / 1e3) : 0;
  const endedMs = typeof body.timestamp === "string" && !Number.isNaN(Date.parse(body.timestamp)) ? Date.parse(body.timestamp) : Date.now();
  const rec = await d.repo.getByProviderCallId(callId);
  const done = await finalizeCall(d, {
    providerCallId: callId,
    startedAt: rec?.startedAt ?? new Date(endedMs - durationSec * 1e3).toISOString(),
    endedAt: new Date(endedMs).toISOString(),
    durationSec,
    transcript
  });
  return { status: 200, body: { handled: true, callId: done.id, verdict: done.verdict, transcript: Boolean(transcript) } };
}

// src/voice/http.ts
var DEGRADED_SAY = "I'm sorry, I'm having trouble on my side. Someone from our team will call you back shortly. Thank you for calling Aangan Studio.";
var json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
function authorised(req, secret) {
  const h = req.headers.get("authorization") ?? "";
  const a = Buffer.from(h), b = Buffer.from(`Bearer ${secret}`);
  return secret.length > 0 && a.length === b.length && timingSafeEqual2(a, b);
}
var isStr = (v) => typeof v === "string" && v.length > 0;
function createHandler(d, cfg) {
  return async function handle(req) {
    const path = new URL(req.url).pathname.replace(/^\/api(?=\/)/, "");
    try {
      if (req.method === "GET" && path === "/health") return json(200, { ok: true });
      if (req.method !== "POST") return json(405, { error: "method not allowed" });
      if (path === "/webhooks/vaani") {
        const raw = await req.text();
        const r = await handleVaaniWebhook(d, raw, req.headers.get("x-vaanivoice-signature"), cfg.vaaniWebhookSecret, { vaaniApiKey: cfg.vaaniApiKey, fetchImpl: cfg.fetchImpl });
        return json(r.status, r.body);
      }
      const desk = (dd, body) => {
        const a = String(body.action ?? "").toLowerCase();
        if (a === "qualify") return qualifyTool(dd, body);
        if (a === "availability" || a === "check_availability") return availabilityTool(dd, body);
        if (a === "book" || a === "book_consultation") return bookTool(dd, body);
        return Promise.resolve({ error: true, say: "Unknown action. Use action qualify, availability or book." });
      };
      const TOOLS = { "/tools/desk": desk, "/tools/qualify": qualifyTool, "/tools/availability": availabilityTool, "/tools/book": bookTool };
      if (!["/call/start", "/call/turn", "/call/end", ...Object.keys(TOOLS)].includes(path)) return json(404, { error: "not found" });
      if (!authorised(req, cfg.brainSecret)) return json(401, { error: "unauthorised" });
      if (path in TOOLS) {
        let tb;
        try {
          tb = await req.json();
        } catch {
          return json(400, { error: "invalid json" });
        }
        try {
          return json(200, await TOOLS[path](d, tb ?? {}));
        } catch (e) {
          console.error("tool failed", path, e);
          return json(200, { say: "That check did not work. Carry on with the rules you were given, and do not quote any price.", error: true });
        }
      }
      let b;
      try {
        b = await req.json();
      } catch {
        return json(400, { error: "invalid json" });
      }
      if (!isStr(b.providerCallId)) return json(400, { error: "providerCallId is required" });
      if (path === "/call/start")
        return json(200, await startCallHandler(d, {
          providerCallId: b.providerCallId,
          startedAt: isStr(b.startedAt) ? b.startedAt : void 0,
          answerLatencyMs: typeof b.answerLatencyMs === "number" ? b.answerLatencyMs : null,
          callerPhone: isStr(b.callerPhone) ? b.callerPhone : null
        }));
      if (path === "/call/turn") {
        if (!isStr(b.utterance)) return json(400, { error: "utterance is required" });
        try {
          return json(200, await turnHandler(d, { providerCallId: b.providerCallId, utterance: b.utterance }));
        } catch (e) {
          if (e instanceof NotFound) throw e;
          console.error("turn failed", e);
          return json(200, { say: DEGRADED_SAY, end: true, degraded: true });
        }
      }
      if (typeof b.durationSec !== "number") return json(400, { error: "durationSec is required" });
      const rec = await endCallHandler(d, { providerCallId: b.providerCallId, endedAt: isStr(b.endedAt) ? b.endedAt : void 0, durationSec: b.durationSec });
      return json(200, { callId: rec.id, verdict: rec.verdict, handoffStatus: rec.handoffStatus, bookingStatus: rec.bookingStatus });
    } catch (e) {
      if (e instanceof NotFound) return json(404, { error: e.message });
      console.error("unhandled", e);
      return json(500, { error: "internal error" });
    }
  };
}

// src/server/bootstrap.ts
var cache = /* @__PURE__ */ new Map();
var once = (k, f2) => cache.has(k) ? cache.get(k) : (cache.set(k, f2()), cache.get(k));
function brainHandler(env = process.env) {
  return once("brain", () => {
    const integ = createIntegrations(env);
    const deps = { ...integ, repo: createRepository(env) };
    return createHandler(deps, { brainSecret: env.BRAIN_SHARED_SECRET ?? "", vaaniWebhookSecret: env.VAANI_WEBHOOK_SECRET ?? "", vaaniApiKey: env.VAANI_API_KEY });
  });
}

// api-src/tools/desk.ts
var POST = (req) => brainHandler()(req);
export {
  POST
};
