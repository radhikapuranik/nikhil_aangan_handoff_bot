import type { Decision, CallFacts } from "../core/types.ts";
import type { CostEntry } from "../core/costs.ts";
import { isAfterHours } from "../core/hours.ts";
import type { CallRepository } from "./repository.ts";
import type { BookingStatus, CallRecord, CrmStatus, DbVerdict, HandoffStatus, TranscriptTurn } from "./types.ts";

// Opens the call row the moment the call is answered, so even a call that
// drops a second later leaves a record.
export async function startCall(
  repo: CallRepository,
  a: { providerCallId?: string; startedAt: string; answerLatencyMs: number | null; callerPhone?: string | null },
): Promise<CallRecord> {
  return repo.createCall({
    providerCallId: a.providerCallId ?? null,
    startedAt: a.startedAt,
    answerLatencyMs: a.answerLatencyMs,
    callerPhone: a.callerPhone ?? null,
    afterHours: isAfterHours(a.startedAt),
  });
}

export interface Outcome {
  decision: Decision | null; // null = caller hung up before any decision
  facts: CallFacts | null;
  transcript: TranscriptTurn[];
  endedAt: string;
  durationSec: number;
  pricingAsked: boolean;
  booking?: { status: BookingStatus; time?: string; ref?: string };
  handoff?: { status: HandoffStatus };
  crm?: { status: CrmStatus; dealId?: string };
  costs: CostEntry[];
  auditIssues?: string[] | null;
  reasonOverride?: string; // when there is no decision to explain the outcome
}

// Every call is logged, whatever happened. Nothing is dropped silently.
export async function finishCall(repo: CallRepository, callId: string, o: Outcome): Promise<CallRecord> {
  const d = o.decision;
  const verdict: DbVerdict =
    !d || d.verdict === "needs_followup" ? "abandoned" : d.verdict;

  let handoff: HandoffStatus = o.handoff?.status ?? "not_applicable";
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
    callerPhone: o.facts?.phone ?? undefined,
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
    crmDealId: o.crm?.dealId ?? null,
  });
  await repo.addCosts(callId, o.costs);
  return rec;
}
