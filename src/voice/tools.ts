import { calcomCost } from "../core/costs.ts";
import { buildHandoffNote } from "../core/handoff.ts";
import { evaluate } from "../core/qualify.ts";
import { telegramCost } from "../core/costs.ts";
import type { AskedCounts, Criterion } from "../core/types.ts";
import { startCall } from "../db/recorder.ts";
import type { CallRecord } from "../db/types.ts";
import { normaliseFacts } from "../integrations/gemini.ts";
import type { SessionDeps } from "../session/call-session.ts";

// Tools the voice platform's AI can call mid-call. They are guardrails, not the
// conversation: the AI speaks, and asks these endpoints to apply Nikhil's rules
// and to book. The AI supplies the facts; no language model is used here.

const now = (d: SessionDeps) => (d.now ?? (() => new Date()))();
const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() && Number.isFinite(Number(v)) ? Number(v) : null);

// Find the call this tool call belongs to: by the platform's call id, else by the
// caller's phone among calls still open, else open a new record so nothing is lost.
export async function resolveCall(d: SessionDeps, a: { callId?: unknown; callerPhone?: unknown }): Promise<CallRecord> {
  const id = str(a.callId), phone = str(a.callerPhone);
  if (id) { const hit = await d.repo.getByProviderCallId(id); if (hit) return hit; }
  if (phone) {
    const since = new Date(now(d).getTime() - 3 * 3600000).toISOString();
    const open = (await d.repo.listCalls({ from: since, to: new Date(now(d).getTime() + 60000).toISOString() }))
      .filter((c) => c.verdict === "in_progress" && c.callerPhone === phone);
    if (open.length) return open[0];
  }
  return startCall(d.repo, { providerCallId: id ?? undefined, startedAt: now(d).toISOString(), answerLatencyMs: null, callerPhone: phone });
}

const ASK_NAMES: Record<string, Criterion> = {
  c1: "c1", c2: "c2", c3: "c3", c4: "c4", c5: "c5",
  project: "c1", real_project: "c1", location: "c2", area: "c2", timeline: "c3", budget: "c4", decision_maker: "c5", decision: "c5",
};

export async function qualifyTool(d: SessionDeps, b: Record<string, unknown>) {
  const rec = await resolveCall(d, b);
  const prior = rec.facts;
  const facts = normaliseFacts({
    callerName: b.callerName, phone: b.callerPhone ?? rec.callerPhone, existingClient: b.existingClient === true || b.existingClient === "true",
    serviceType: b.serviceType, intent: b.intent, location: b.location, sqft: num(b.sqft), rooms: num(b.rooms), currentState: b.currentState,
    timeline: { kind: b.timelineKind, weeks: num(b.timelineWeeks) }, decisionMaker: b.decisionMaker, decisionMakerNote: b.decisionMakerNote,
    budgetMinRupees: num(b.budgetMinRupees), budgetMaxRupees: num(b.budgetMaxRupees),
  }, prior);

  // Which criteria the AI has already asked about; each repeat counts as one more ask.
  const asked: AskedCounts = {};
  for (const x of Array.isArray(b.alreadyAsked) ? b.alreadyAsked : []) {
    const c = ASK_NAMES[String(x).toLowerCase()];
    if (c) asked[c] = (asked[c] ?? 0) + 1;
  }
  const dec = evaluate(facts, asked, now(d));
  const patch: Partial<CallRecord> = { facts, callerName: facts.callerName ?? rec.callerName, callerPhone: facts.phone ?? rec.callerPhone };

  // An existing client must reach a senior person within minutes, so alert now, not after the call.
  if (dec.verdict === "escalated" && rec.handoffStatus !== "escalation_pending") {
    try {
      await d.notifier.send("senior", `URGENT: existing-client issue. Senior callback needed within 15 minutes.\nCaller: ${facts.callerName ?? "(name not given)"} | ${facts.phone ?? rec.callerPhone ?? "(phone not captured)"}\n(Call still in progress.)`);
      patch.handoffStatus = "escalation_pending";
      await d.repo.addCosts(rec.id, [telegramCost(d.rates)]);
    } catch { /* the post-call step will try again */ }
  }
  await d.repo.updateCall(rec.id, patch);

  const next: Record<string, string> = {
    needs_followup: "Ask the caller this question, in your own natural words only if you keep its meaning: ",
    declined: "Say exactly this, word for word, then end the call politely: ",
    deferred: "Say exactly this, word for word: ",
    escalated: "Say exactly this, word for word. The senior team has already been alerted: ",
    qualified: "The caller qualifies. Call check_availability and offer the slots. ",
  };
  return {
    callId: rec.providerCallId ?? rec.id,
    verdict: dec.verdict, say: dec.say, ask: dec.ask ?? null, flags: dec.flags, earliestStart: dec.earliestStart ?? null,
    instruction: next[dec.verdict] + (dec.say ?? ""),
  };
}

export async function availabilityTool(d: SessionDeps, b: Record<string, unknown>) {
  const rec = await resolveCall(d, b);
  try {
    const slots = await d.calendar.findSlots(2, now(d));
    await d.repo.addCosts(rec.id, [calcomCost(d.rates)]);
    return { callId: rec.providerCallId ?? rec.id, slots, say: slots.length ? null : "No consultation slots are free right now. Tell the caller their designer will call to arrange a time." };
  } catch {
    return { callId: rec.providerCallId ?? rec.id, slots: [], say: "The calendar is unavailable. Tell the caller their designer will call to arrange a time." };
  }
}

export async function bookTool(d: SessionDeps, b: Record<string, unknown>) {
  const rec = await resolveCall(d, b);
  const start = str(b.slotStart);
  if (!start) return { confirmed: false, say: "No slot was chosen. Ask the caller which slot they prefer." };
  const facts = rec.facts;
  const name = str(b.callerName) ?? facts?.callerName ?? null, phone = str(b.callerPhone) ?? facts?.phone ?? rec.callerPhone;
  try {
    const label = new Date(start).toLocaleString("en-IN", { weekday: "long", day: "numeric", month: "long", hour: "numeric", minute: "2-digit", hour12: true, timeZone: "Asia/Kolkata" });
    const booked = await d.calendar.book({
      slot: { start, label }, name, phone,
      notes: facts ? buildHandoffNote(facts, evaluate(facts, { c1: 2, c2: 2, c3: 2, c5: 2 }, now(d)), { booked: true, when: label }) : (str(b.notes) ?? "Booked by phone agent"),
    });
    await d.repo.addCosts(rec.id, [calcomCost(d.rates)]);
    await d.repo.updateCall(rec.id, { bookingStatus: "booked", bookingTime: booked.start, bookingRef: booked.ref, callerName: name ?? undefined, callerPhone: phone ?? undefined });
    return { confirmed: true, bookingRef: booked.ref, start: booked.start, say: `The consultation is booked for ${label}. Confirm this to the caller and tell them their designer will already have everything they have said.` };
  } catch {
    await d.repo.updateCall(rec.id, { bookingStatus: "failed" });
    return { confirmed: false, say: "The booking did not go through. Tell the caller their designer will call them to confirm a time. Do not say it is booked." };
  }
}
