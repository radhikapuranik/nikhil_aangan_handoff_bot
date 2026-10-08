import {
  calcomCost, geminiCost, hubspotCost, telegramCost, vaaniCost, DEFAULT_RATES, type CostEntry,
} from "../core/costs.ts";
import { ISSUE_TEXT, type AuditIssue } from "../core/audit.ts";
import { buildHandoffNote } from "../core/handoff.ts";
import type { CallFacts, Decision } from "../core/types.ts";
import { finishCall } from "../db/recorder.ts";
import type { BookingStatus, CallRecord, CrmStatus, HandoffStatus, TranscriptTurn } from "../db/types.ts";
import type { Usage } from "../integrations/types.ts";
import type { SessionDeps } from "./call-session.ts";

export interface CallOutcome {
  decision: Decision | null;
  facts: CallFacts | null;
  transcript: TranscriptTurn[];
  endedAt: string;
  durationSec: number;
  pricingAsked: boolean;
  booking: { status: BookingStatus; time?: string; ref?: string };
  usage: Usage;
  calendarCalls: number;
  audit?: AuditIssue[] | null; // null/undefined = not audited
}

// Everything that happens once a call is over, whichever path ended it: the
// live brain (CallSession) or the voice platform's call-completed webhook.
export async function completeCall(d: SessionDeps, rec: CallRecord, o: CallOutcome): Promise<CallRecord> {
  // Idempotent: a second end-of-call signal must not resend the handoff or deal.
  if (rec.verdict !== "in_progress") return rec;
  const rates = d.rates ?? DEFAULT_RATES;
  const costs: CostEntry[] = [vaaniCost(o.durationSec, rates)];
  if (o.usage.inputTokens || o.usage.outputTokens) costs.push(...geminiCost(o.usage.inputTokens, o.usage.outputTokens, rates));
  for (let i = 0; i < o.calendarCalls; i++) costs.push(calcomCost(rates));

  const dec = o.decision;
  let handoff: { status: HandoffStatus } | undefined;
  let crm: { status: CrmStatus; dealId?: string } | undefined;

  if (dec?.verdict === "qualified" && o.facts) {
    const note = buildHandoffNote(o.facts, dec, {
      booked: o.booking.status === "booked",
      when: o.booking.time ? new Date(o.booking.time).toLocaleString("en-IN", { dateStyle: "full", timeStyle: "short", timeZone: "Asia/Kolkata" }) : undefined,
    });
    try { await d.notifier.send("designers", note); costs.push(telegramCost(rates)); handoff = { status: "sent" }; }
    catch { handoff = { status: "failed" }; }
    try {
      const deal = await d.crm.createDeal({
        dealName: `${o.facts.callerName ?? "Phone enquiry"} — ${o.facts.location ?? "Pune"} ${o.facts.serviceType.replace(/_/g, " ")}`,
        contactName: o.facts.callerName ?? null, phone: o.facts.phone ?? rec.callerPhone ?? null, note,
      });
      costs.push(hubspotCost(rates)); crm = { status: "created", dealId: deal.dealId };
    } catch { crm = { status: "failed" }; }
  } else if (dec?.verdict === "escalated") {
    // The tool may already have alerted the senior team mid-call; only alert here if not.
    const already = rec.handoffStatus === "escalation_pending";
    if (already) handoff = { status: "escalation_pending" };
    else {
      const lines = o.transcript.filter((t) => t.speaker === "caller").map((t) => `- ${t.text}`).join("\n");
      const msg = `URGENT: existing-client issue. Senior callback needed within 15 minutes.\nCaller: ${o.facts?.callerName ?? "(name not given)"} | ${o.facts?.phone ?? rec.callerPhone ?? "(phone not captured)"}\nWhat they said:\n${lines}`;
      try { await d.notifier.send("senior", msg); costs.push(telegramCost(rates)); handoff = { status: "escalation_pending" }; }
      catch { handoff = { status: "failed" }; }
    }
  }

  // The agent said something it should not have: a person needs to know now.
  if (o.audit && o.audit.length) {
    try {
      await d.notifier.send("senior", `SCRIPT BREACH on a call (${rec.id.slice(0, 8)}):\n- ${o.audit.map((i) => ISSUE_TEXT[i]).join("\n- ")}\nCaller: ${o.facts?.callerName ?? "(name not given)"} | ${o.facts?.phone ?? rec.callerPhone ?? "(phone not captured)"}`);
      costs.push(telegramCost(rates));
    } catch { /* the breach is still recorded on the call row and shown on the dashboard */ }
  }

  return finishCall(d.repo, rec.id, {
    decision: dec, facts: o.facts, transcript: o.transcript, endedAt: o.endedAt, durationSec: o.durationSec,
    pricingAsked: o.pricingAsked,
    booking: dec?.verdict === "qualified" ? o.booking : undefined,
    handoff, crm, costs, auditIssues: o.audit ?? null,
  });
}
