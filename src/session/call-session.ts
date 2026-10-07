import {
  calcomCost, geminiCost, hubspotCost, telegramCost, vaaniCost, DEFAULT_RATES,
  type CostEntry, type Rates,
} from "../core/costs.ts";
import { FAQ_ANSWERS } from "../core/faq.ts";
import { buildHandoffNote } from "../core/handoff.ts";
import { guardSpeech, isPricingQuestion, pricingResponse } from "../core/pricing.ts";
import { evaluate } from "../core/qualify.ts";
import { openingLine } from "../core/scripts.ts";
import type { AskedCounts, CallFacts, Decision } from "../core/types.ts";
import { finishCall, startCall } from "../db/recorder.ts";
import type { CallRepository } from "../db/repository.ts";
import type { BookingStatus, CallRecord, CrmStatus, HandoffStatus, TranscriptTurn } from "../db/types.ts";
import type { Integrations, Slot, Usage } from "../integrations/types.ts";

export interface SessionDeps extends Integrations {
  repo: CallRepository;
  rates?: Rates;
  now?: () => Date;
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
    return { session: s, greeting };
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

  // One caller utterance in, the agent's reply out.
  async hear(utterance: string): Promise<{ say: string; end: boolean }> {
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

  // Called on hang-up (or once the agent has ended the call). Sends the
  // handoff, creates the deal, and writes the call row and cost ledger.
  async finish(a: { endedAt: string; durationSec: number }): Promise<CallRecord> {
    const rates = this.d.rates ?? DEFAULT_RATES;
    const costs: CostEntry[] = [vaaniCost(a.durationSec, rates)];
    if (this.usage.inputTokens || this.usage.outputTokens) costs.push(...geminiCost(this.usage.inputTokens, this.usage.outputTokens, rates));
    if (this.calendarCalls) for (let i = 0; i < this.calendarCalls; i++) costs.push(calcomCost(rates));

    const dec = this.decision;
    let handoff: { status: HandoffStatus } | undefined;
    let crm: { status: CrmStatus; dealId?: string } | undefined;

    if (dec?.verdict === "qualified" && this.facts) {
      const note = buildHandoffNote(this.facts, dec, {
        booked: this.booking.status === "booked",
        when: this.booking.time ? new Date(this.booking.time).toLocaleString("en-IN", { dateStyle: "full", timeStyle: "short", timeZone: "Asia/Kolkata" }) : undefined,
      });
      try { await this.d.notifier.send("designers", note); costs.push(telegramCost(rates)); handoff = { status: "sent" }; }
      catch { handoff = { status: "failed" }; }
      try {
        const deal = await this.d.crm.createDeal({
          dealName: `${this.facts.callerName ?? "Phone enquiry"} — ${this.facts.location ?? "Pune"} ${this.facts.serviceType.replace(/_/g, " ")}`,
          contactName: this.facts.callerName ?? null, phone: this.facts.phone ?? null, note,
        });
        costs.push(hubspotCost(rates)); crm = { status: "created", dealId: deal.dealId };
      } catch { crm = { status: "failed" }; }
    } else if (dec?.verdict === "escalated") {
      const lines = this.transcript.filter((t) => t.speaker === "caller").map((t) => `- ${t.text}`).join("\n");
      const msg = `URGENT: existing-client issue. Senior callback needed within 15 minutes.\nCaller: ${this.facts?.callerName ?? "(name not given)"} | ${this.facts?.phone ?? "(phone not captured)"}\nWhat they said:\n${lines}`;
      try { await this.d.notifier.send("senior", msg); costs.push(telegramCost(rates)); handoff = { status: "escalation_pending" }; }
      catch { handoff = { status: "failed" }; }
    }

    this.phase = "closed";
    return finishCall(this.d.repo, this.rec.id, {
      decision: dec, facts: this.facts, transcript: this.transcript,
      endedAt: a.endedAt, durationSec: a.durationSec, pricingAsked: this.pricingAsked,
      booking: dec?.verdict === "qualified" ? this.booking : undefined,
      handoff, crm, costs,
    });
  }
}
