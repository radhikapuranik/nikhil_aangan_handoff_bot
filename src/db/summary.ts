import { totalCost } from "../core/costs.ts";
import type { CallRecord, DateRange, FixedCost, StoredCost } from "./types.ts";

export interface Summary {
  totalCalls: number;
  afterHoursCalls: number;
  verdicts: Record<string, number>;
  consultationsBooked: number;
  pricingQuestions: number;
  latency: { medianMs: number | null; p95Ms: number | null; maxMs: number | null; under5MinPct: number | null };
  cost: {
    perCallInr: number;      // variable costs
    fixedInr: number;        // pro-rated monthly charges
    totalInr: number;
    perCallAvgInr: number | null;
    incomplete: boolean;     // true if any rate was unknown
    byService: Record<string, number>;
  };
}

const pct = (sorted: number[], p: number) =>
  sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)] : null;

const DAY = 86400000;

// Pro-rate monthly fixed charges over the days of the range they were active.
function fixedForRange(fixed: FixedCost[], r: DateRange): { inr: number; incomplete: boolean } {
  let inr = 0, incomplete = false;
  const from = new Date(r.from).getTime(), to = new Date(r.to).getTime();
  for (const f of fixed) {
    const start = Math.max(from, new Date(f.activeFrom).getTime());
    const end = Math.min(to, f.activeTo ? new Date(f.activeTo).getTime() + DAY : to);
    if (end <= start) continue;
    if (f.monthlyInr === null) { incomplete = true; continue; }
    inr += (f.monthlyInr * ((end - start) / DAY)) / 30;
  }
  return { inr: Math.round(inr * 100) / 100, incomplete };
}

export function summarise(calls: CallRecord[], costs: StoredCost[], fixed: FixedCost[], range: DateRange): Summary {
  const verdicts: Record<string, number> = {};
  for (const c of calls) verdicts[c.verdict] = (verdicts[c.verdict] ?? 0) + 1;

  const lat = calls.map((c) => c.answerLatencyMs).filter((x): x is number => x !== null).sort((a, b) => a - b);
  const variable = totalCost(costs);
  const fx = fixedForRange(fixed, range);
  const byService: Record<string, number> = {};
  for (const c of costs) if (c.costInr !== null) byService[c.service] = Math.round(((byService[c.service] ?? 0) + c.costInr) * 10000) / 10000;

  const total = Math.round((variable.inr + fx.inr) * 100) / 100;
  return {
    totalCalls: calls.length,
    afterHoursCalls: calls.filter((c) => c.afterHours).length,
    verdicts,
    consultationsBooked: calls.filter((c) => c.bookingStatus === "booked").length,
    pricingQuestions: calls.filter((c) => c.pricingAsked).length,
    latency: {
      medianMs: pct(lat, 0.5), p95Ms: pct(lat, 0.95), maxMs: lat.length ? lat[lat.length - 1] : null,
      under5MinPct: lat.length ? Math.round((lat.filter((x) => x <= 5 * 60000).length / lat.length) * 1000) / 10 : null,
    },
    cost: {
      perCallInr: variable.inr, fixedInr: fx.inr, totalInr: total,
      perCallAvgInr: calls.length ? Math.round((total / calls.length) * 100) / 100 : null,
      incomplete: variable.incomplete || fx.incomplete,
      byService,
    },
  };
}
