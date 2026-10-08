import { test } from "node:test";
import assert from "node:assert/strict";
import { MemoryRepository } from "../src/db/memory.ts";
import { SupabaseRepository } from "../src/db/supabase.ts";
import { startCall, finishCall } from "../src/db/recorder.ts";
import { summarise } from "../src/db/summary.ts";
import { calcomCost, geminiCost, totalCost, vaaniCost, DEFAULT_RATES } from "../src/core/costs.ts";
import { isAfterHours } from "../src/core/hours.ts";
import { evaluate } from "../src/core/qualify.ts";
import { PHONE_FIXTURES } from "../src/fixtures/phone-transcripts.ts";

const RANGE = { from: "2026-09-01T00:00:00Z", to: "2026-10-01T00:00:00Z" };

test("after-hours uses IST 10:00-19:00", () => {
  assert.equal(isAfterHours("2026-09-09T17:17:00Z"), true);  // 22:47 IST (T08)
  assert.equal(isAfterHours("2026-09-02T04:53:00Z"), false); // 10:23 IST (T01)
  assert.equal(isAfterHours("2026-09-04T13:30:00Z"), true);  // 19:00 IST
  assert.equal(isAfterHours("2026-09-04T04:29:00Z"), true);  // 09:59 IST
});

test("unknown Vaani rate stays null and marks totals incomplete, never zero", () => {
  const v = vaaniCost(240, { ...DEFAULT_RATES, vaaniPerMinuteInr: null });
  assert.equal(v.costInr, null);
  assert.deepEqual(totalCost([v, ...geminiCost(1000, 200)]).incomplete, true);
  const known = vaaniCost(240, { ...DEFAULT_RATES, vaaniPerMinuteInr: 6 });
  assert.equal(known.units, 4); assert.equal(known.costInr, 24);
  assert.equal(vaaniCost(60).costInr, 5.58); // Vaani dashboard estimate for this agent
});

test("gemini cost converts tokens to INR", () => {
  const [i, o] = geminiCost(1_000_000, 1_000_000, { ...DEFAULT_RATES, usdToInr: 100 });
  assert.equal(i.costInr, 30); assert.equal(o.costInr, 250); // $0.30 and $2.50 per M tokens
});

async function logFixture(repo: MemoryRepository, id: string, startedAt: string, latency = 800) {
  const fx = PHONE_FIXTURES.find((f) => f.id === id)!;
  const call = await startCall(repo, { providerCallId: "p-" + id, startedAt, answerLatencyMs: latency });
  const decision = fx.facts ? evaluate(fx.facts, { c5: 1, c3: 2, c1: 1 }, new Date("2026-09-01")) : null;
  return finishCall(repo, call.id, {
    decision, facts: fx.facts, transcript: [], endedAt: startedAt, durationSec: 240,
    pricingAsked: !!fx.pricingQuestions,
    costs: [vaaniCost(240, { ...DEFAULT_RATES, vaaniPerMinuteInr: 5 }), ...geminiCost(3000, 400)],
  });
}

test("every outcome is logged: qualified, declined, deferred, escalated, abandoned", async () => {
  const repo = new MemoryRepository();
  const q = await logFixture(repo, "T01", "2026-09-02T05:00:00Z");
  const d = await logFixture(repo, "T03", "2026-09-03T10:00:00Z");
  const df = await logFixture(repo, "T07", "2026-09-08T04:00:00Z");
  const e = await logFixture(repo, "T09", "2026-09-10T06:00:00Z");
  assert.equal(q.verdict, "qualified"); assert.equal(q.handoffStatus, "pending");
  assert.equal(q.bookingStatus, "offered"); assert.equal(q.crmStatus, "pending");
  assert.equal(d.verdict, "declined"); assert.equal(d.handoffStatus, "not_applicable");
  assert.equal(df.verdict, "deferred");
  assert.equal(e.verdict, "escalated"); assert.equal(e.handoffStatus, "escalation_pending");

  const call = await startCall(repo, { providerCallId: "drop", startedAt: "2026-09-22T08:44:00Z", answerLatencyMs: 900 });
  const ab = await finishCall(repo, call.id, { decision: null, facts: null, transcript: [], endedAt: "x", durationSec: 72, pricingAsked: false, costs: [] });
  assert.equal(ab.verdict, "abandoned"); assert.ok(ab.reasons[0].includes("hung up"));
});

test("a retried webhook does not create a second call or reset a finished one", async () => {
  const repo = new MemoryRepository();
  const rec = await logFixture(repo, "T01", "2026-09-02T05:00:00Z");
  const again = await startCall(repo, { providerCallId: "p-T01", startedAt: "2026-09-02T05:00:00Z", answerLatencyMs: 1 });
  assert.equal(again.id, rec.id); assert.equal(again.verdict, "qualified");
  assert.equal(repo.calls.size, 1);
});

test("summary: counts, latency, after-hours, booked, pricing, cost", async () => {
  const repo = new MemoryRepository();
  await logFixture(repo, "T01", "2026-09-02T05:00:00Z", 700);
  await logFixture(repo, "T02", "2026-09-03T09:00:00Z", 900);   // pricing asked
  await logFixture(repo, "T08", "2026-09-09T17:17:00Z", 1100);  // after hours (facts null -> abandoned)
  const rec = [...repo.calls.values()][0];
  await repo.updateCall(rec.id, { bookingStatus: "booked" });
  const fx = [{ service: "number", monthlyInr: 0, activeFrom: "2026-01-01", activeTo: null }];
  const s = summarise(await repo.listCalls(RANGE), await repo.listCosts(RANGE), fx, RANGE);
  assert.equal(s.totalCalls, 3); assert.equal(s.afterHoursCalls, 1);
  assert.equal(s.consultationsBooked, 1); assert.equal(s.pricingQuestions, 1);
  assert.equal(s.latency.medianMs, 900); assert.equal(s.latency.under5MinPct, 100);
  assert.equal(s.verdicts.qualified, 2); assert.equal(s.verdicts.abandoned, 1);
  assert.equal(s.cost.incomplete, false);
  assert.ok(s.cost.totalInr > 0 && s.cost.byService.vaani === 60);
});

test("fixed monthly costs are pro-rated; unknown ones mark the total incomplete", async () => {
  const repo = new MemoryRepository();
  const range = { from: "2026-09-01T00:00:00Z", to: "2026-09-16T00:00:00Z" }; // 15 days
  const s = summarise([], [], [{ service: "vaani_number", monthlyInr: 3000, activeFrom: "2026-08-01", activeTo: null }], range);
  assert.equal(s.cost.fixedInr, 1500); assert.equal(s.cost.incomplete, false);
  const u = summarise([], [], [{ service: "plan", monthlyInr: null, activeFrom: "2026-08-01", activeTo: null }], range);
  assert.equal(u.cost.incomplete, true);
  void repo;
});

test("no fixed-fee rows is reported as incomplete, never as zero", () => {
  const s = summarise([], [], [], RANGE);
  assert.equal(s.cost.incomplete, true);
  assert.ok(s.cost.incompleteReasons[0].includes("no fixed monthly fees"));
});

test("cost-free services are recorded as explicit zero rows", () => {
  assert.equal(calcomCost().costInr, 0);
});

test("supabase repo: ignores duplicate on create, maps snake/camel, sends service key", async () => {
  const seen: { url: string; init: RequestInit }[] = [];
  const row = { id: "u1", provider_call_id: "p1", started_at: "2026-09-02T05:00:00Z", verdict: "qualified", answer_latency_ms: 700 };
  const fakeFetch = (async (url: string, init: RequestInit) => {
    seen.push({ url, init });
    const first = seen.length === 1;
    return new Response(JSON.stringify(first ? [] : [row]), { status: 200 }); // 1st: conflict -> no rows
  }) as unknown as typeof fetch;
  const repo = new SupabaseRepository("https://x.supabase.co", "KEY", fakeFetch);
  const rec = await repo.createCall({ providerCallId: "p1", startedAt: "2026-09-02T05:00:00Z" });
  assert.equal(rec.id, "u1"); assert.equal(rec.answerLatencyMs, 700);
  const h = seen[0].init.headers as Record<string, string>;
  assert.equal(h.apikey, "KEY"); assert.ok(h.Prefer.includes("ignore-duplicates"));
  assert.ok(!h.Prefer.includes("merge-duplicates"));
  assert.ok(JSON.parse(seen[0].init.body as string).started_at);
});

test("supabase repo surfaces HTTP errors", async () => {
  const f = (async () => new Response("boom", { status: 500 })) as unknown as typeof fetch;
  await assert.rejects(new SupabaseRepository("https://x.supabase.co", "K", f).listCalls(RANGE), /500/);
});
