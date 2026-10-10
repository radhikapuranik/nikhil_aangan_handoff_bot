import type { Rates } from "../core/costs.ts";
import { FAQ_ANSWERS } from "../core/faq.ts";
import { buildHandoffNote } from "../core/handoff.ts";
import { completeCall } from "./post-call.ts";
import { guardSpeech, isPricingQuestion, pricingResponse } from "../core/pricing.ts";
import { evaluate } from "../core/qualify.ts";
import { openingLine } from "../core/scripts.ts";
import type { AskedCounts, CallFacts, Decision } from "../core/types.ts";
import { startCall } from "../db/recorder.ts";
import type { CallRepository } from "../db/repository.ts";
import type { BookingStatus, CallRecord, TranscriptTurn } from "../db/types.ts";
import type { Integrations, Slot, Usage } from "../integrations/types.ts";

export interface SessionDeps extends Integrations {
  repo: CallRepository;
  rates?: Rates;
  now?: () => Date;
  autoBook?: boolean; // book the first free slot after a qualified call that was not booked in the call (default on)
}

type Phase = "qualifying" | "offering_slots" | "closed";
const MAX_CALLER_TURNS = 25;

// NOT IN SPEC: the spec scripts the qualifying conversation, scripts and
// decision logic, but not the booking confirmation lines below.
const SAY = {
  offer: (a: Slot, b: Slot | undefined) =>
    b ? `Wonderful — I can book your consultation right now. I have ${a.label}, or ${b.label}. Which works better for you?`
      : `Wonderful — I can book your consultation right now. I have ${a.label}. Does that work for you?`,
  reoffer: "Sorry, I didn't catch which one — could you tell me which slot you'd prefer?",
  booked: (label: string) => `You're booked for ${label}. Your designer will already have everything you've told me. Thank you for calling Aangan Studio.`,
  noBooking: "No problem. Your designer will have everything you've told me and will reach out to arrange a time. Thank you for calling Aangan Studio.",
  bookingFailed: "I'm sorry, I couldn't confirm the slot just now. Your designer will have everything you've told me and will call you to confirm a time. Thank you for calling Aangan Studio.",
  tooLong: "Thank you for the details. Your designer will have everything you've told me and will be in touch. Thank you for calling Aangan Studio.",
};

interface Snapshot {
  facts: CallFacts | null; asked: AskedCounts; decision: Decision | null; phase: Phase;
  slots: Slot[]; slotRetries: number; callerTurns: number; pricingAsked: boolean;
  usage: Usage; booking: { status: BookingStatus; time?: string; ref?: string };
  calendarCalls: number; lastQuestionCriterion: keyof AskedCounts | null;
}

const ist = (d: Date) => new Date(d.getTime() + 330 * 60000);

export class CallSession {
  private d: SessionDeps;
  private rec: CallRecord;
  private transcript: TranscriptTurn[] = [];
  private facts: CallFacts | null = null;
  private asked: AskedCounts = {};
  private decision: Decision | null = null;
  private phase: Phase = "qualifying";
  private slots: Slot[] = [];
  private slotRetries = 0;
  private callerTurns = 0;
  private pricingAsked = false;
  private usage: Usage = { inputTokens: 0, outputTokens: 0 };
  private booking: { status: BookingStatus; time?: string; ref?: string } = { status: "not_applicable" };
  private calendarCalls = 0;
  private lastQuestionCriterion: keyof AskedCounts | null = null;

  private constructor(d: SessionDeps, rec: CallRecord) { this.d = d; this.rec = rec; }

  static async start(d: SessionDeps, a: { providerCallId?: string; startedAt: string; answerLatencyMs: number | null; callerPhone?: string | null }) {
    const rec = await startCall(d.repo, a);
    const s = new CallSession(d, rec);
    const greeting = openingLine(ist(new Date(a.startedAt)).getUTCHours());
    s.say(greeting);
    await s.persist();
    return { session: s, greeting };
  }

  // Rebuild a session from the database so any server instance can take the
  // next turn of a call in progress.
  static resume(d: SessionDeps, rec: CallRecord): CallSession {
    const s = new CallSession(d, rec);
    s.transcript = [...rec.transcript];
    const st = rec.sessionState as Snapshot | null;
    if (st) {
      s.facts = st.facts; s.asked = st.asked; s.decision = st.decision; s.phase = st.phase;
      s.slots = st.slots; s.slotRetries = st.slotRetries; s.callerTurns = st.callerTurns;
      s.pricingAsked = st.pricingAsked; s.usage = st.usage; s.booking = st.booking;
      s.calendarCalls = st.calendarCalls; s.lastQuestionCriterion = st.lastQuestionCriterion;
    }
    if (rec.verdict !== "in_progress") s.phase = "closed";
    return s;
  }

  snapshot(): Snapshot {
    return {
      facts: this.facts, asked: this.asked, decision: this.decision, phase: this.phase,
      slots: this.slots, slotRetries: this.slotRetries, callerTurns: this.callerTurns,
      pricingAsked: this.pricingAsked, usage: this.usage, booking: this.booking,
      calendarCalls: this.calendarCalls, lastQuestionCriterion: this.lastQuestionCriterion,
    };
  }

  // Write the in-call state after every turn. If this server dies, the next
  // turn (or the end-of-call webhook) resumes from here.
  async persist() {
    this.rec = await this.d.repo.updateCall(this.rec.id, {
      transcript: this.transcript, facts: this.facts, sessionState: this.snapshot(),
    });
  }

  get callId() { return this.rec.id; }
  get ended() { return this.phase === "closed"; }

  private now() { return (this.d.now ?? (() => new Date()))(); }
  private addUsage(u: Usage) { this.usage.inputTokens += u.inputTokens; this.usage.outputTokens += u.outputTokens; }
  private say(text: string) {
    const safe = guardSpeech(text).text; // last line of defence for the pricing rule
    this.transcript.push({ speaker: "agent", text: safe, at: this.now().toISOString() });
    return safe;
  }

  // One caller utterance in, the agent's reply out. State is saved afterwards.
  async hear(utterance: string): Promise<{ say: string; end: boolean }> {
    const r = await this.hearInner(utterance);
    await this.persist();
    return r;
  }

  private async hearInner(utterance: string): Promise<{ say: string; end: boolean }> {
    this.transcript.push({ speaker: "caller", text: utterance, at: this.now().toISOString() });
    this.callerTurns++;
    const reply = (text: string, end = false) => {
      if (end) this.phase = "closed";
      return { say: this.say(text), end };
    };

    if (this.phase === "offering_slots") return this.handleSlotChoice(utterance, reply);

    if (this.callerTurns > MAX_CALLER_TURNS) return reply(SAY.tooLong, true);

    // Read everything the caller has said so far, then decide.
    const ex = await this.d.llm.extractFacts(this.transcript, this.facts);
    this.addUsage(ex.usage);
    this.facts = ex.facts;
    if (!this.facts.phone && this.rec.callerPhone) this.facts.phone = this.rec.callerPhone;
    const asking = isPricingQuestion(utterance);
    if (asking) this.pricingAsked = true;

    // The question the agent just asked counts as asked only if the
    // conversation moves forward. A detour (price, FAQ) leaves it open.
    const askedNow: AskedCounts = { ...this.asked };
    if (this.lastQuestionCriterion)
      askedNow[this.lastQuestionCriterion] = (askedNow[this.lastQuestionCriterion] ?? 0) + 1;
    const dec = evaluate(this.facts, askedNow, this.now());
    this.decision = dec;

    // Terminal outcomes come first, even if the caller also asked about price.
    if (dec.verdict === "declined" || dec.verdict === "deferred" || dec.verdict === "escalated")
      return reply(dec.say!, true);

    if (asking) return reply(pricingResponse());

    const tri = await this.d.llm.triage(utterance);
    this.addUsage(tri.usage);
    if (tri.route === "faq") return reply(FAQ_ANSWERS[tri.topic]);

    this.asked = askedNow;
    this.lastQuestionCriterion = null;
    if (dec.verdict === "needs_followup") {
      this.lastQuestionCriterion = dec.ask!;
      return reply(dec.say!);
    }

    // Qualified: book in the same call.
    return this.offerSlots(reply);
  }

  private async offerSlots(reply: (t: string, end?: boolean) => { say: string; end: boolean }) {
    try {
      this.calendarCalls++;
      this.slots = await this.d.calendar.findSlots(2, this.now());
    } catch { this.slots = []; }
    if (!this.slots.length) {
      this.booking = { status: "failed" };
      return reply(SAY.bookingFailed, true);
    }
    this.booking = { status: "offered" };
    this.phase = "offering_slots";
    return reply(SAY.offer(this.slots[0], this.slots[1]));
  }

  private async handleSlotChoice(utterance: string, reply: (t: string, end?: boolean) => { say: string; end: boolean }) {
    const c = await this.d.llm.chooseSlot(utterance, this.slots);
    this.addUsage(c.usage);
    if (c.declined) { this.booking = { status: "declined_by_caller" }; return reply(SAY.noBooking, true); }
    if (c.index === null) {
      if (this.slotRetries++ < 1) return reply(SAY.reoffer);
      this.booking = { status: "declined_by_caller" };
      return reply(SAY.noBooking, true);
    }
    const slot = this.slots[c.index];
    try {
      this.calendarCalls++;
      const b = await this.d.calendar.book({
        slot, name: this.facts?.callerName ?? null, phone: this.facts?.phone ?? null,
        notes: buildHandoffNote(this.facts!, this.decision!, { booked: true, when: slot.label }),
      });
      this.booking = { status: "booked", time: b.start, ref: b.ref };
      return reply(SAY.booked(slot.label), true);
    } catch {
      this.booking = { status: "failed" };
      return reply(SAY.bookingFailed, true);
    }
  }

  // Called on hang-up (or once the agent has ended the call).
  async finish(a: { endedAt: string; durationSec: number }): Promise<CallRecord> {
    this.phase = "closed";
    return completeCall(this.d, this.rec, {
      decision: this.decision, facts: this.facts, transcript: this.transcript,
      endedAt: a.endedAt, durationSec: a.durationSec, pricingAsked: this.pricingAsked,
      booking: this.booking, usage: this.usage, calendarCalls: this.calendarCalls,
    });
  }
}
