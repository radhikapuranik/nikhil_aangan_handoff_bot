import { randomUUID } from "node:crypto";
import type { FaqTopic } from "../core/faq.ts";
import type { CallFacts } from "../core/types.ts";
import type { TranscriptTurn } from "../db/types.ts";
import { slotLabel } from "./calcom.ts";
import { normaliseFacts } from "./gemini.ts";
import type { Calendar, Crm, LlmService, Notifier, Slot } from "./types.ts";

const ZERO = { inputTokens: 0, outputTokens: 0 };

// MOCK ONLY. A crude keyword reader so the whole call flow runs with no API
// keys. It is NOT a substitute for Gemini extraction and is not what the
// verdict tests rely on.
export class MockLlm implements LlmService {
  async triage(u: string) {
    const t = u.toLowerCase();
    const topic: [RegExp, FaqTopic][] = [
      [/what (do|does) (you|aangan)|what services/, "services"],
      [/which areas|where do you work|do you (work|serve|cover)/, "service_area"],
      [/how long|how many weeks|timeline for/, "timelines"],
      [/offices?|commercial/, "commercial"],
      [/don'?t do|not do|restaurant|hotel/, "not_offered"],
      [/rented|tenant/, "rented"],
    ];
    const general = /^(what|which|how long|do you|does aangan|can you tell me what)/.test(t) && !/\b(my|our|i have|we have|i'm|we're)\b/.test(t);
    const hit = general ? topic.find(([re]) => re.test(t)) : undefined;
    return hit ? { route: "faq" as const, topic: hit[1], usage: ZERO } : { route: "qualify" as const, usage: ZERO };
  }

  async extractFacts(transcript: TranscriptTurn[], prior: CallFacts | null) {
    const caller = transcript.filter((x) => x.speaker === "caller").map((x) => x.text).join(" ");
    const t = caller.toLowerCase();
    const raw: Record<string, unknown> = {};
    const loc = t.match(/\b(kothrud|baner|aundh|wakad|koregaon park|kalyani nagar|viman nagar|hadapsar|magarpatta|nibm|kondhwa|undri|warje|deccan|pimple saudagar|ravet|hinjewadi|kharadi|nashik|mumbai|talegaon|lonavala)\b/);
    if (loc) raw.location = loc[1];
    const sq = t.match(/([\d,]{3,6})\s*(?:sq\.?\s*ft|square feet|sqft)/);
    if (sq) raw.sqft = Number(sq[1].replace(/,/g, ""));
    raw.existingClient = /my designer|my project has been going|already (have|has) a designer/.test(t);
    if (/restaurant/.test(t)) raw.serviceType = "restaurant";
    else if (/\bgym\b/.test(t)) raw.serviceType = "gym";
    else if (/office|clinic/.test(t)) raw.serviceType = "commercial_office";
    else if (/3bhk|4bhk|2bhk|whole|full (home|flat)|complete redesign/.test(t)) raw.serviceType = "full_home";
    if (/just (looking for )?ideas|only (need )?(advice|suggestions)|just exploring/.test(t)) raw.intent = "advice_only";
    else if (/full (redesign|home|execution)|complete redesign|design and execution|redo the whole/.test(t)) raw.intent = "full_execution";
    const wk = t.match(/(\d+)\s*weeks?/);
    if (wk) raw.timeline = { kind: "complete_by", weeks: Number(wk[1]) };
    else if (/no rush|flexible|plenty of time/.test(t)) raw.timeline = { kind: "flexible", weeks: null };
    if (/\b(i|myself)\b.*\b(decide|owner)\b|i am the owner|yes,? (i am|me)/.test(t)) raw.decisionMaker = "self";
    return { facts: normaliseFacts(raw, prior), usage: ZERO };
  }

  async chooseSlot(u: string, slots: Slot[]) {
    const t = u.toLowerCase();
    if (/\b(no|not now|don'?t|later)\b/.test(t)) return { index: null, declined: true, usage: ZERO };
    if (/\b(first|1|one|earlier)\b/.test(t)) return { index: 0, declined: false, usage: ZERO };
    if (/\b(second|2|two|later one)\b/.test(t) && slots.length > 1) return { index: 1, declined: false, usage: ZERO };
    return { index: null, declined: false, usage: ZERO };
  }
}

export class MockCalendar implements Calendar {
  booked: { slot: Slot; name: string | null; phone: string | null; notes: string; ref: string }[] = [];
  failNext = false;

  async findSlots(count: number, after: Date) {
    const out: Slot[] = [];
    const d = new Date(after);
    // Weekdays 11:00 and 16:00 IST, from the day after `after`.
    for (let i = 1; out.length < count && i < 15; i++) {
      const day = new Date(d.getTime() + i * 86400000);
      const dow = new Date(day.getTime() + 330 * 60000).getUTCDay();
      if (dow === 0 || dow === 6) continue;
      const hh = out.length % 2 === 0 ? 11 : 16;
      const start = new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), hh - 5, 30)).toISOString();
      if (this.booked.some((b) => b.slot.start === start)) continue;
      out.push({ start, label: slotLabel(start) });
    }
    return out;
  }
  async book(a: { slot: Slot; name: string | null; phone: string | null; notes: string }) {
    if (this.failNext) { this.failNext = false; throw new Error("mock calendar failure"); }
    const ref = "mock-" + randomUUID().slice(0, 8);
    this.booked.push({ ...a, ref });
    return { ref, start: a.slot.start };
  }
}

export class MockNotifier implements Notifier {
  sent: { channel: string; text: string }[] = [];
  fail = false;
  async send(channel: "designers" | "senior", text: string) {
    if (this.fail) throw new Error("mock telegram failure");
    this.sent.push({ channel, text });
    return { messageId: String(this.sent.length) };
  }
}

export class MockCrm implements Crm {
  deals: { dealName: string; contactName: string | null; phone: string | null; note: string; dealId: string }[] = [];
  fail = false;
  async createDeal(a: { dealName: string; contactName: string | null; phone: string | null; note: string }) {
    if (this.fail) throw new Error("mock hubspot failure");
    const dealId = "deal-" + (this.deals.length + 1);
    this.deals.push({ ...a, dealId });
    return { dealId };
  }
}
