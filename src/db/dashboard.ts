import type { CallRepository } from "./repository.ts";
import { summarise, type Summary } from "./summary.ts";
import type { CallRecord, DateRange, StoredCost } from "./types.ts";

export interface RecentCall {
  id: string; startedAt: string; afterHours: boolean; phoneMasked: string | null; name: string | null;
  verdict: string; reasons: string[]; flags: string[]; pricingAsked: boolean;
  handoffStatus: string; bookingStatus: string; bookingTime: string | null; crmStatus: string;
  durationSec: number | null; answerLatencyMs: number | null;
  costInr: number | null; // null = at least one rate unknown
}

export interface DashboardData {
  range: DateRange;
  summary: Summary;
  daily: { date: string; inHours: number; afterHours: number }[]; // IST dates
  attention: RecentCall[]; // calls that need a human
  recent: RecentCall[];
}

// +91 98xxx x1234 -> "••••• 1234". Dashboards are shared; full numbers stay in the database.
export const maskPhone = (p: string | null) => (p ? "•••••• " + p.replace(/\D/g, "").slice(-4) : null);

const istDate = (iso: string) => new Date(new Date(iso).getTime() + 330 * 60000).toISOString().slice(0, 10);

// A call needs a human if something that should have happened did not.
export function needsAttention(c: CallRecord): boolean {
  return (
    c.handoffStatus === "failed" || c.handoffStatus === "escalation_pending" ||
    c.crmStatus === "failed" || c.bookingStatus === "failed" ||
    (c.verdict === "qualified" && c.handoffStatus === "pending")
  );
}

function toRecent(c: CallRecord, costs: StoredCost[]): RecentCall {
  const mine = costs.filter((x) => x.callId === c.id);
  return {
    id: c.id, startedAt: c.startedAt, afterHours: c.afterHours, phoneMasked: maskPhone(c.callerPhone), name: c.callerName,
    verdict: c.verdict, reasons: c.reasons, flags: c.flags, pricingAsked: c.pricingAsked,
    handoffStatus: c.handoffStatus, bookingStatus: c.bookingStatus, bookingTime: c.bookingTime, crmStatus: c.crmStatus,
    durationSec: c.durationSec, answerLatencyMs: c.answerLatencyMs,
    costInr: mine.some((x) => x.costInr === null) || !mine.length ? null : Math.round(mine.reduce((a, x) => a + (x.costInr ?? 0), 0) * 100) / 100,
  };
}

export async function buildDashboard(repo: CallRepository, range: DateRange): Promise<DashboardData> {
  const [calls, costs, fixed] = await Promise.all([repo.listCalls(range), repo.listCosts(range), repo.listFixedCosts()]);
  const summary = summarise(calls, costs, fixed, range);

  const byDay = new Map<string, { inHours: number; afterHours: number }>();
  // Fill every day in the range so quiet days show as zero rather than vanishing.
  for (let t = new Date(range.from).getTime(); t < new Date(range.to).getTime(); t += 86400000) {
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
    range, summary, daily,
    attention: sorted.filter(needsAttention).slice(0, 20).map((c) => toRecent(c, costs)),
    recent: sorted.slice(0, 40).map((c) => toRecent(c, costs)),
  };
}
