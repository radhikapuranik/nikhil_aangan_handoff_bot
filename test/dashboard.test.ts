import { test } from "node:test";
import assert from "node:assert/strict";
import { MemoryRepository } from "../src/db/memory.ts";
import { buildDashboard, maskPhone, needsAttention } from "../src/db/dashboard.ts";
import { seedDemo } from "../src/fixtures/seed.ts";

const NOW = new Date("2026-10-07T12:00:00Z");
const RANGE = { from: "2026-09-08T00:00:00Z", to: "2026-10-08T00:00:00Z" };

test("seeded dashboard: counts add up, ~1/3 after hours, every day present, latency near zero", async () => {
  const repo = new MemoryRepository();
  await seedDemo(repo, { now: NOW });
  const d = await buildDashboard(repo, RANGE);
  const s = d.summary;
  assert.equal(s.totalCalls, 70);
  assert.equal(Object.values(s.verdicts).reduce((a, b) => a + b, 0), 70);
  assert.ok(s.afterHoursCalls > 10 && s.afterHoursCalls < 35, String(s.afterHoursCalls));
  assert.equal(d.daily.length, 30);
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
