import { vaaniCost, DEFAULT_RATES } from "../core/costs.ts";
import { finishCall, startCall } from "../db/recorder.ts";
import type { CallRecord } from "../db/types.ts";
import { CallSession, type SessionDeps } from "../session/call-session.ts";

// The "brain" any voice platform calls. Three operations, all stateless on
// our side: the call lives in the database between requests.

export async function startCallHandler(d: SessionDeps, a: { providerCallId: string; startedAt?: string; answerLatencyMs?: number | null; callerPhone?: string | null }) {
  const { session, greeting } = await CallSession.start(d, {
    providerCallId: a.providerCallId,
    startedAt: a.startedAt ?? (d.now ?? (() => new Date()))().toISOString(),
    answerLatencyMs: a.answerLatencyMs ?? null,
    callerPhone: a.callerPhone ?? null,
  });
  return { callId: session.callId, say: greeting, end: false };
}

async function load(d: SessionDeps, ref: { callId?: string; providerCallId?: string }): Promise<CallRecord | null> {
  if (ref.providerCallId) return d.repo.getByProviderCallId(ref.providerCallId);
  return null;
}

export async function turnHandler(d: SessionDeps, a: { providerCallId: string; utterance: string }) {
  const rec = await load(d, a);
  if (!rec) throw new NotFound(`no call with provider id ${a.providerCallId}`);
  const s = CallSession.resume(d, rec);
  if (s.ended) return { callId: rec.id, say: "", end: true };
  const r = await s.hear(a.utterance);
  return { callId: rec.id, ...r };
}

export async function endCallHandler(d: SessionDeps, a: { providerCallId: string; endedAt?: string; durationSec: number }): Promise<CallRecord> {
  const rec = await load(d, a);
  if (!rec) throw new NotFound(`no call with provider id ${a.providerCallId}`);
  const s = CallSession.resume(d, rec);
  return s.finish({ endedAt: a.endedAt ?? (d.now ?? (() => new Date()))().toISOString(), durationSec: a.durationSec });
}

// Safety net: a call that reached the voice platform but never reached us
// (our server was down, or the flow was misconfigured) is still logged.
export async function logUnseenCall(d: SessionDeps, a: { providerCallId: string; startedAt: string; durationSec: number; reason: string; callerPhone?: string | null }) {
  const rec = await startCall(d.repo, { providerCallId: a.providerCallId, startedAt: a.startedAt, answerLatencyMs: null, callerPhone: a.callerPhone ?? null });
  return finishCall(d.repo, rec.id, {
    decision: null, facts: null, transcript: [], endedAt: new Date(new Date(a.startedAt).getTime() + a.durationSec * 1000).toISOString(),
    durationSec: a.durationSec, pricingAsked: false, costs: [vaaniCost(a.durationSec, d.rates ?? DEFAULT_RATES)],
    reasonOverride: a.reason,
  });
}

export class NotFound extends Error {}
