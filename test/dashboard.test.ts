import { test } from "node:test";
import assert from "node:assert/strict";
import { MemoryRepository } from "../src/db/memory.ts";
import { buildDashboard, maskPhone, needsAttention } from "../src/db/dashboard.ts";
import { seedDemo } from "../src/fixtures/seed.ts";

const NOW = new Date("2026-10-07T12:00:00Z");
const RANGE = { from: "2026-09-07T00:00:00Z", to: "2026-10-08T00:00:00Z" }; // covers the seed window [now-30d, now] completely

test("seeded dashboard: counts add up, ~1/3 after hours, every day present, latency near zero", async () => {
  const repo = new MemoryRepository();
  await seedDemo(repo, { now: NOW });
  const d = await buildDashboard(repo, RANGE);
  const s = d.summary;
  assert.equal(s.totalCalls, 70);
  assert.equal(Object.values(s.verdicts).reduce((a, b) => a + b, 0), 70);
  assert.ok(s.afterHoursCalls > 10 && s.afterHoursCalls < 35, String(s.afterHoursCalls));
  assert.equal(d.daily.length, 31);
  assert.equal(d.daily.reduce((a, x) => a + x.inHours + x.afterHours, 0), 70);
  assert.ok(s.latency.medianMs! < 3000); assert.equal(s.latency.under5MinPct, 100);
  assert.ok(s.cost.totalInr > 0 && s.cost.byService.vaani > 0);
  assert.equal(s.cost.incomplete, true); // demo fixed fees are deliberately unknown
  assert.ok(d.recent.some((c) => c.phoneMasked), "caller numbers survive finishing a call");
});

test("phone numbers are masked in dashboard rows", async () => {
  assert.equal(maskPhone("+91 98123 45678"), "•••••• 5678");
  assert.equal(maskPhone(null), null);
  const repo = new MemoryRepository();
  await seedDemo(repo, { now: NOW, calls: 5 });
  const d = await buildDashboard(repo, RANGE);
  assert.ok(!JSON.stringify(d).match(/\+9198\d{8}/));
});

test("attention list flags failed handoffs, failed CRM/booking, pending escalations", async () => {
  const base = { verdict: "qualified", handoffStatus: "sent", crmStatus: "created", bookingStatus: "booked" } as any;
  assert.equal(needsAttention(base), false);
  assert.equal(needsAttention({ ...base, handoffStatus: "failed" }), true);
  assert.equal(needsAttention({ ...base, crmStatus: "failed" }), true);
  assert.equal(needsAttention({ ...base, bookingStatus: "failed" }), true);
  assert.equal(needsAttention({ ...base, verdict: "escalated", handoffStatus: "escalation_pending" }), true);
  assert.equal(needsAttention({ ...base, handoffStatus: "pending" }), true);
  assert.equal(needsAttention({ ...base, verdict: "declined", handoffStatus: "not_applicable", crmStatus: "not_applicable", bookingStatus: "not_applicable" }), false);
});

test("empty range gives zeros and nulls, not NaN", async () => {
  const d = await buildDashboard(new MemoryRepository(), RANGE);
  assert.equal(d.summary.totalCalls, 0); assert.equal(d.summary.latency.medianMs, null);
  assert.equal(d.summary.cost.perCallAvgInr, null); assert.deepEqual(d.recent, []);
});

test("call details are in plain words: caller, project, location, timeline, decision-maker, budget", async () => {
  const { describeFacts } = await import("../src/db/dashboard.ts");
  const { PHONE_FIXTURES } = await import("../src/fixtures/phone-transcripts.ts");
  const t14 = describeFacts(PHONE_FIXTURES.find((f) => f.id === "T14")!.facts, null);
  assert.equal(t14.location, "Hadapsar"); assert.equal(t14.project, "Full home");
  assert.ok(t14.decisionMaker.startsWith("Family will attend and decide") && t14.decisionMaker.includes("parents"));
  assert.equal(t14.budget, "None volunteered"); assert.equal(t14.timeline, "Not stated");
  const t10 = describeFacts(PHONE_FIXTURES.find((f) => f.id === "T10")!.facts, null);
  assert.equal(t10.budget, "₹1–1.5 lakh (volunteered)"); assert.equal(t10.project, "Part of a home · 550 sq ft");
  const t01 = describeFacts(PHONE_FIXTURES.find((f) => f.id === "T01")!.facts, null);
  assert.equal(t01.callerName, "Priya"); assert.equal(t01.timeline, "Finish within ~26 weeks"); assert.equal(t01.project, "Full home · 1400 sq ft");
  assert.equal(describeFacts(null, "Sam").callerName, "Sam");
  assert.equal(describeFacts(null, null).location, "Not captured");
});

test("spoken phone numbers are masked in transcripts, other numbers are not", async () => {
  const { maskDigits, safeTranscript } = await import("../src/db/dashboard.ts");
  assert.equal(maskDigits("My number is 98 22 00 11 22."), "My number is •••••• 1122.");
  assert.equal(maskDigits("call +91 98123 45678 please"), "call •••••• 5678 please");
  assert.equal(maskDigits("about 1400 sq ft, 5 months, 2BHK"), "about 1400 sq ft, 5 months, 2BHK");
  const t = safeTranscript([{ speaker: "caller", text: "it's 9822001122", at: "x" }]);
  assert.equal(t[0].text, "it's •••••• 1122");
  assert.deepEqual(safeTranscript(null), []);
});

test("the dashboard data carries the transcript and details for each recent call", async () => {
  const repo = new MemoryRepository();
  await seedDemo(repo, { now: NOW, calls: 3 });
  const d = await buildDashboard(repo, RANGE);
  assert.ok(d.recent.every((c) => c.transcript.length > 0 && c.details.location.length > 0 && c.details.project.length > 0));
  assert.ok(!JSON.stringify(d).match(/\+9198\d{8}/));
});
