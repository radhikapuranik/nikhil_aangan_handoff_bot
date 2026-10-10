import { auditAgentTurns, type AuditIssue } from "../core/audit.ts";
import { isPricingQuestion } from "../core/pricing.ts";
import { evaluate } from "../core/qualify.ts";
import type { Decision } from "../core/types.ts";
import { startCall } from "../db/recorder.ts";
import type { CallRecord, TranscriptTurn } from "../db/types.ts";
import type { SessionDeps } from "../session/call-session.ts";
import { judgeConversation } from "../session/judge.ts";
import { completeCall } from "../session/post-call.ts";

const MIN = 60000;

// Match a finished call to the record the tools opened, when the platform's
// call id was not passed to the tools: a single open call in the right window.
export async function matchOpenCall(d: SessionDeps, a: { startedAt: string; endedAt: string }): Promise<CallRecord | null> {
  const from = new Date(new Date(a.startedAt).getTime() - 10 * MIN).toISOString();
  const to = new Date(new Date(a.endedAt).getTime() + 2 * MIN).toISOString();
  const open = (await d.repo.listCalls({ from, to })).filter((c) => c.verdict === "in_progress" && !c.sessionState);
  return open.length === 1 ? open[0] : null;
}

export interface Finished {
  providerCallId: string;
  startedAt: string; endedAt: string; durationSec: number;
  transcript: TranscriptTurn[] | null;
}

// The call is over and the voice platform has sent what it has. Decide, audit,
// hand off, record. This is the authoritative result for platform-run calls.
export async function finalizeCall(d: SessionDeps, f: Finished): Promise<CallRecord> {
  let rec = (await d.repo.getByProviderCallId(f.providerCallId)) ?? (await matchOpenCall(d, f));
  if (!rec) rec = await startCall(d.repo, { providerCallId: f.providerCallId, startedAt: f.startedAt, answerLatencyMs: null });
  if (rec.providerCallId !== f.providerCallId && !rec.providerCallId) rec = await d.repo.updateCall(rec.id, { providerCallId: f.providerCallId });
  if (rec.verdict !== "in_progress") return rec;

  const today = new Date(f.startedAt);
  let decision: Decision | null = null;
  let facts = rec.facts;
  let usage = { inputTokens: 0, outputTokens: 0 };
  let audit: AuditIssue[] | null = null;
  const turns = f.transcript && f.transcript.length ? f.transcript : null;

  if (turns) {
    const j = await judgeConversation(d.llm, turns, today, rec.facts);
    facts = j.facts; decision = j.decision; usage = j.usage;
  } else if (rec.facts) {
    // No transcript arrived, but the tools recorded facts during the call: judge on those.
    decision = evaluate(rec.facts, { c1: 2, c2: 2, c3: 2, c5: 2 }, today);
  }

  // Nothing about the project was captured (caller hung up, or the line was silent): not a lead.
  const known = facts;
  if (turns && decision?.verdict === "qualified" && known && known.serviceType === "unknown" && known.intent === "unclear" && !known.location && !known.sqft && known.timeline.kind === "unknown" && !known.existingClient) {
    decision = null;
  }

  if (turns) {
    audit = auditAgentTurns(turns, { verdict: decision?.verdict ?? "abandoned" });
    if (rec.bookingStatus === "booked" && decision && decision.verdict !== "qualified") audit.push("booked_despite_verdict");
  }

  const reasonless = !decision;
  const done = await completeCall(d, rec, {
    decision, facts, transcript: turns ?? rec.transcript, endedAt: f.endedAt, durationSec: f.durationSec,
    pricingAsked: turns ? turns.some((t) => t.speaker === "caller" && isPricingQuestion(t.text)) : rec.pricingAsked,
    booking: { status: rec.bookingStatus === "not_applicable" ? "offered" : rec.bookingStatus, time: rec.bookingTime ?? undefined, ref: rec.bookingRef ?? undefined },
    usage, calendarCalls: 0, audit,
  });
  if (reasonless) await d.repo.updateCall(done.id, { reasons: [turns ? "no enquiry details were captured in the call" : "call ended with no transcript and no tool activity"] });
  return done;
}
