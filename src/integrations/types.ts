import type { FaqTopic } from "../core/faq.ts";
import type { CallFacts } from "../core/types.ts";
import type { TranscriptTurn } from "../db/types.ts";

export interface Usage { inputTokens: number; outputTokens: number }

export interface LlmService {
  // Route one caller utterance: a general services question, or the project talk.
  triage(utterance: string): Promise<{ route: "faq"; topic: FaqTopic; usage: Usage } | { route: "qualify"; usage: Usage }>;
  // Read the whole conversation so far and return the facts the caller has stated.
  extractFacts(transcript: TranscriptTurn[], prior: CallFacts | null): Promise<{ facts: CallFacts; usage: Usage }>;
  // Which offered slot did the caller pick?
  chooseSlot(utterance: string, slots: Slot[]): Promise<{ index: number | null; declined: boolean; usage: Usage }>;
}

export interface Slot { start: string; label: string } // start = ISO, label = spoken

export interface Calendar {
  findSlots(count: number, after: Date): Promise<Slot[]>;
  // Every free slot in a window, so a caller's chosen time can be checked exactly.
  slotsBetween(from: Date, to: Date): Promise<Slot[]>;
  book(a: { slot: Slot; name: string | null; phone: string | null; notes: string }): Promise<{ ref: string; start: string }>;
}

export interface Notifier {
  send(channel: "designers" | "senior", text: string): Promise<{ messageId: string }>;
}

export interface Crm {
  createDeal(a: { dealName: string; contactName: string | null; phone: string | null; note: string }): Promise<{ dealId: string }>;
}

export interface Integrations { llm: LlmService; calendar: Calendar; notifier: Notifier; crm: Crm }
