import type { CallRepository } from "./repository.ts";
import { summarise, type Summary } from "./summary.ts";
import type { CallFacts } from "../core/types.ts";
import type { CallRecord, DateRange, StoredCost, TranscriptTurn } from "./types.ts";

// What the designer would want at a glance, in plain words.
export interface CallDetails {
  callerName: string | null;
  project: string;        // "Full home · 1400 sq ft"
  location: string;
  timeline: string;
  decisionMaker: string;
  budget: string;         // only what the caller volunteered; the agent never quotes a price
  currentState: string;
}

export interface RecentCall {
  id: string; startedAt: string; afterHours: boolean; phoneMasked: string | null; name: string | null;
  verdict: string; reasons: string[]; flags: string[]; pricingAsked: boolean;
  handoffStatus: string; bookingStatus: string; bookingTime: string | null; crmStatus: string;
  durationSec: number | null; answerLatencyMs: number | null;
  auditIssues: string[] | null;
  details: CallDetails;
  transcript: TranscriptTurn[]; // phone numbers masked
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


const SERVICE_LABEL: Record<string, string> = {
  full_home: "Full home", partial_home: "Part of a home", single_room: "Single room", commercial_office: "Office / commercial",
  restaurant: "Restaurant", hotel: "Hotel", retail: "Retail", gym: "Gym", architecture_structural: "Architecture / structural",
  decor_only: "Decor only", furniture_only: "Furniture only", vastu_only: "Vastu only", unknown: "Not stated",
};

const lakh = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1));

export function describeFacts(f: CallFacts | null, fallbackName: string | null): CallDetails {
  if (!f) return { callerName: fallbackName, project: "Not captured", location: "Not captured", timeline: "Not captured", decisionMaker: "Not captured", budget: "Not captured", currentState: "Not captured" };
  const t = f.timeline;
  const dm: Record<CallFacts["decisionMaker"], string> = {
    self: "Caller decides", authorised: "Caller, authorised by someone else", family_attending: "Family will attend and decide",
    research_only: "Researching for someone else", unknown: "Not confirmed",
  };
  return {
    callerName: f.callerName ?? fallbackName,
    project: [SERVICE_LABEL[f.serviceType] ?? f.serviceType, f.sqft ? `${f.sqft} sq ft` : null].filter(Boolean).join(" · "),
    location: f.location ?? "Not stated",
    timeline: t.kind === "flexible" ? "Flexible" : t.kind === "unknown" || t.weeks === null ? "Not stated" : `${t.kind === "start_by" ? "Start within" : "Finish within"} ~${t.weeks} weeks`,
    decisionMaker: dm[f.decisionMaker] + (f.decisionMakerNote ? ` (${f.decisionMakerNote})` : ""),
    budget: f.budgetLakh ? `₹${lakh(f.budgetLakh.min)}–${lakh(f.budgetLakh.max)} lakh (volunteered)` : "None volunteered",
    currentState: f.currentState ?? "Not stated",
  };
}

// Dashboards are shared, so long digit runs (phone numbers the caller spoke) are masked in transcripts too.
export const maskDigits = (text: string) =>
  text.replace(/\+?\d[\d\s\-]{6,}\d/g, (m) => (m.replace(/\D/g, "").length >= 9 ? "•••••• " + m.replace(/\D/g, "").slice(-4) : m));

export const safeTranscript = (t: TranscriptTurn[] | null | undefined): TranscriptTurn[] =>
  (t ?? []).slice(0, 200).map((x) => ({ speaker: x.speaker, at: x.at, text: maskDigits(String(x.text).slice(0, 2000)) }));

// A call needs a human if something that should have happened did not.
export function needsAttention(c: CallRecord): boolean {
  return (
    c.handoffStatus === "failed" || c.handoffStatus === "escalation_pending" ||
    c.crmStatus === "failed" || c.bookingStatus === "failed" ||
    (c.verdict === "qualified" && c.handoffStatus === "pending") ||
    Boolean(c.auditIssues && c.auditIssues.length)
  );
}

function toRecent(c: CallRecord, costs: StoredCost[]): RecentCall {
  const mine = costs.filter((x) => x.callId === c.id);
  return {
    id: c.id, startedAt: c.startedAt, afterHours: c.afterHours, phoneMasked: maskPhone(c.callerPhone), name: c.callerName,
    verdict: c.verdict, reasons: c.reasons, flags: c.flags, pricingAsked: c.pricingAsked,
    handoffStatus: c.handoffStatus, bookingStatus: c.bookingStatus, bookingTime: c.bookingTime, crmStatus: c.crmStatus,
    durationSec: c.durationSec, answerLatencyMs: c.answerLatencyMs, auditIssues: c.auditIssues ?? null,
    details: describeFacts(c.facts, c.callerName), transcript: safeTranscript(c.transcript),
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
