import { FAQ_TOPICS, type FaqTopic } from "../core/faq.ts";
import type { CallFacts, DecisionMaker, Intent, ServiceType } from "../core/types.ts";
import type { TranscriptTurn } from "../db/types.ts";
import type { LlmService, Slot, Usage } from "./types.ts";

export const DEFAULT_GEMINI_MODEL = "gemini-3.5-flash-lite";

const SERVICE_TYPES: ServiceType[] = ["full_home", "partial_home", "single_room", "commercial_office", "restaurant", "hotel", "retail", "gym", "architecture_structural", "decor_only", "furniture_only", "vastu_only", "unknown"];
const INTENTS: Intent[] = ["full_execution", "advice_only", "unclear"];
const DECISION_MAKERS: DecisionMaker[] = ["self", "authorised", "family_attending", "research_only", "unknown"];
const TIMELINE_KINDS = ["start_by", "complete_by", "flexible", "unknown"] as const;

const pick = <T extends string>(v: unknown, allowed: readonly T[], fallback: T): T =>
  typeof v === "string" && (allowed as readonly string[]).includes(v) ? (v as T) : fallback;
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

// Model output is untrusted: coerce it into a valid CallFacts, falling back to
// "unknown" for anything off-schema. Exported for tests.
export function normaliseFacts(raw: Record<string, unknown>, prior: CallFacts | null): CallFacts {
  const t = (raw.timeline ?? {}) as Record<string, unknown>;
  const b = raw.budgetLakh as Record<string, unknown> | null | undefined;
  const facts: CallFacts = {
    callerName: str(raw.callerName),
    phone: str(raw.phone),
    existingClient: raw.existingClient === true,
    serviceType: pick(raw.serviceType, SERVICE_TYPES, "unknown"),
    intent: pick(raw.intent, INTENTS, "unclear"),
    location: str(raw.location),
    sqft: num(raw.sqft),
    rooms: num(raw.rooms),
    currentState: str(raw.currentState),
    timeline: {
      kind: pick(t.kind, TIMELINE_KINDS, "unknown"),
      weeks: num(t.weeks),
    },
    decisionMaker: pick(raw.decisionMaker, DECISION_MAKERS, "unknown"),
    decisionMakerNote: str(raw.decisionMakerNote),
    budgetLakh: b && num(b.min) !== null && num(b.max) !== null ? { min: num(b.min)!, max: num(b.max)! } : null,
  };
  if (facts.timeline.kind === "unknown") facts.timeline.weeks = null;
  // Information the caller gave earlier is not lost if a later pass misses it.
  if (prior) {
    facts.callerName ??= prior.callerName ?? null;
    facts.phone ??= prior.phone ?? null;
    facts.location ??= prior.location;
    facts.sqft ??= prior.sqft;
    facts.rooms ??= prior.rooms;
    facts.currentState ??= prior.currentState;
    facts.budgetLakh ??= prior.budgetLakh;
    if (facts.serviceType === "unknown") facts.serviceType = prior.serviceType;
    if (facts.intent === "unclear") facts.intent = prior.intent;
    if (facts.timeline.kind === "unknown") facts.timeline = prior.timeline;
    if (facts.decisionMaker === "unknown") { facts.decisionMaker = prior.decisionMaker; facts.decisionMakerNote ??= prior.decisionMakerNote ?? null; }
    if (prior.existingClient) facts.existingClient = true;
  }
  return facts;
}

const EXTRACT_SYSTEM = `You read a phone conversation between a caller and the Aangan Studio interior design agent and record ONLY what the CALLER has actually said. Never infer, assume, or fill gaps; use null / "unknown" / "unclear" when the caller has not said it.
- existingClient: true only if the caller already has a designer or an in-progress project with Aangan and is raising an issue about it.
- serviceType: full_home (whole home), partial_home (2+ rooms or a floor), single_room, commercial_office (office/clinic/studio), or an out-of-scope type (restaurant, hotel, retail, gym, architecture_structural, decor_only, furniture_only, vastu_only).
- intent: full_execution if they want design and execution done by the studio; advice_only if they only want ideas, advice, or will execute themselves; else unclear.
- timeline: kind start_by (execution must start by) or complete_by (must be finished by) with weeks counted from today; flexible; or unknown.
- decisionMaker: self; authorised (spouse/partner who is not on the call has told them to go ahead); family_attending (e.g. parents who will attend the consultation and decide); research_only (just researching for someone else, no confirmation they will be involved); else unknown.
- budgetLakh: ONLY if the caller states a figure, in lakh. Otherwise null.
Today is {TODAY}.`;

const EXTRACT_SCHEMA = {
  type: "OBJECT",
  properties: {
    callerName: { type: "STRING", nullable: true },
    phone: { type: "STRING", nullable: true },
    existingClient: { type: "BOOLEAN" },
    serviceType: { type: "STRING", enum: SERVICE_TYPES },
    intent: { type: "STRING", enum: INTENTS },
    location: { type: "STRING", nullable: true },
    sqft: { type: "NUMBER", nullable: true },
    rooms: { type: "NUMBER", nullable: true },
    currentState: { type: "STRING", nullable: true },
    timeline: {
      type: "OBJECT",
      properties: { kind: { type: "STRING", enum: [...TIMELINE_KINDS] }, weeks: { type: "NUMBER", nullable: true } },
      required: ["kind"],
    },
    decisionMaker: { type: "STRING", enum: DECISION_MAKERS },
    decisionMakerNote: { type: "STRING", nullable: true },
    budgetLakh: { type: "OBJECT", nullable: true, properties: { min: { type: "NUMBER" }, max: { type: "NUMBER" } } },
  },
  required: ["existingClient", "serviceType", "intent", "timeline", "decisionMaker"],
};

const asText = (t: TranscriptTurn[]) => t.map((x) => `${x.speaker === "agent" ? "Agent" : "Caller"}: ${x.text}`).join("\n");

export class GeminiLlm implements LlmService {
  private apiKey: string;
  private model: string;
  private fetchImpl: typeof fetch;
  private now: () => Date;

  constructor(apiKey: string, model = DEFAULT_GEMINI_MODEL, fetchImpl: typeof fetch = fetch, now: () => Date = () => new Date()) {
    this.apiKey = apiKey;
    this.model = model;
    this.fetchImpl = fetchImpl;
    this.now = now;
  }

  private async generate(system: string, user: string, schema: object): Promise<{ json: Record<string, unknown>; usage: Usage }> {
    const res = await this.fetchImpl(`https://generativelanguage.googleapis.com/v1beta/models/${this.model}:generateContent`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": this.apiKey },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: "user", parts: [{ text: user }] }],
        generationConfig: { temperature: 0, responseMimeType: "application/json", responseSchema: schema },
      }),
    });
    if (!res.ok) throw new Error(`Gemini ${this.model} -> ${res.status}: ${await res.text()}`);
    const body = (await res.json()) as {
      candidates?: { content?: { parts?: { text?: string }[] } }[];
      usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number };
    };
    const text = body.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
    let json: Record<string, unknown> = {};
    try { json = JSON.parse(text); } catch { /* handled by normalisers: empty object -> all unknown */ }
    const u = body.usageMetadata ?? {};
    return { json, usage: { inputTokens: u.promptTokenCount ?? 0, outputTokens: (u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0) } };
  }

  async triage(utterance: string) {
    const { json, usage } = await this.generate(
      "Classify one caller utterance to an interior design studio. route=faq ONLY if it is a general question about what the studio does, where it works, how long projects take, commercial size limits, what it does not do, or rented flats, with no details about the caller's own project. Anything about the caller's own project or situation is route=qualify.",
      utterance,
      { type: "OBJECT", properties: { route: { type: "STRING", enum: ["faq", "qualify"] }, topic: { type: "STRING", enum: FAQ_TOPICS } }, required: ["route"] },
    );
    const topic = pick(json.topic, FAQ_TOPICS as readonly FaqTopic[], "services");
    return json.route === "faq" ? { route: "faq" as const, topic, usage } : { route: "qualify" as const, usage };
  }

  async extractFacts(transcript: TranscriptTurn[], prior: CallFacts | null) {
    const { json, usage } = await this.generate(
      EXTRACT_SYSTEM.replace("{TODAY}", this.now().toISOString().slice(0, 10)),
      asText(transcript),
      EXTRACT_SCHEMA,
    );
    return { facts: normaliseFacts(json, prior), usage };
  }

  async chooseSlot(utterance: string, slots: Slot[]) {
    const { json, usage } = await this.generate(
      "The agent offered the caller numbered appointment slots. Decide which one the caller chose (1-based), or whether they declined all of them. If unclear, return choice 0 and declined false.",
      `Slots: ${slots.map((s, i) => `${i + 1}. ${s.label}`).join("; ")}\nCaller: ${utterance}`,
      { type: "OBJECT", properties: { choice: { type: "INTEGER" }, declined: { type: "BOOLEAN" } }, required: ["choice", "declined"] },
    );
    const c = num(json.choice);
    const index = c !== null && c >= 1 && c <= slots.length ? c - 1 : null;
    return { index, declined: json.declined === true, usage };
  }
}
