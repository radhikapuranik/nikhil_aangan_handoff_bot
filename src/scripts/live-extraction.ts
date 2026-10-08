import { readFile } from "node:fs/promises";
import { geminiCost, totalCost } from "../core/costs.ts";
import type { CallFacts } from "../core/types.ts";
import { judgeConversation } from "../session/judge.ts";
import { PHONE_FIXTURES } from "../fixtures/phone-transcripts.ts";
import { DEFAULT_GEMINI_MODEL, GeminiLlm } from "../integrations/gemini.ts";

// Runs the REAL T01-T20 conversations through live Gemini, then the decision
// engine, and compares with the expected verdicts and the hand-written facts.
// Usage: npm run live:extract
const key = process.env.GEMINI_API_KEY;
if (!key) { console.error("GEMINI_API_KEY is not set"); process.exit(1); }
const model = process.env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL;
const texts = JSON.parse(await readFile(new URL("../fixtures/phone-transcripts-text.json", import.meta.url), "utf8")) as { id: string; date: string; turns: { speaker: "agent" | "caller"; text: string }[] }[];

let inTok = 0, outTok = 0, agree = 0, total = 0, reads = 0;
const diffs: string[] = [];
const keyFields: (keyof CallFacts)[] = ["existingClient", "serviceType", "intent", "decisionMaker"];

const only = process.argv.slice(2);
const todo = texts.filter((t) => !only.length || only.includes(t.id));
async function one(t: (typeof texts)[number]) {
  const lines: string[] = [];
  const log = (x: string) => lines.push(x);
  const fx = PHONE_FIXTURES.find((f) => f.id === t.id)!;
  if (!t.turns.length || !fx.facts) { log(`${t.id}  skipped (no conversation)`); return lines; }
  const llm = new GeminiLlm(key, model, fetch, () => new Date(t.date));
  const today = new Date(t.date);

  // Same routine the post-call finaliser uses.
  const j = await judgeConversation(llm, t.turns.map((x) => ({ ...x, at: t.date })), today);
  inTok += j.usage.inputTokens; outTok += j.usage.outputTokens; reads += j.reads;
  const facts = j.facts, d = j.decision, turnsUsed = j.turnsUsed;
  const callerIdx = t.turns.filter((x) => x.speaker === "caller");
  if (!d || !facts) { log(`${t.id}  ERROR no result`); return lines; }
  const ok = d.verdict === fx.expected; total++; if (ok) agree++;

  const mine = fx.facts;
  const dif: string[] = [];
  for (const k of keyFields) if (facts[k] !== mine[k]) dif.push(`${k}: gemini=${facts[k]} mine=${mine[k]}`);
  if (facts.timeline.kind !== mine.timeline.kind || facts.timeline.weeks !== mine.timeline.weeks) dif.push(`timeline: gemini=${facts.timeline.kind}/${facts.timeline.weeks} mine=${mine.timeline.kind}/${mine.timeline.weeks}`);
  if ((facts.sqft ?? null) !== (mine.sqft ?? null)) dif.push(`sqft: gemini=${facts.sqft} mine=${mine.sqft}`);
  if ((facts.location ?? "").toLowerCase().split(/[ (]/)[0] !== (mine.location ?? "").toLowerCase().split(/[ (]/)[0]) dif.push(`location: gemini=${facts.location} mine=${mine.location}`);
  if (JSON.stringify(facts.budgetLakh) !== JSON.stringify(mine.budgetLakh)) dif.push(`budget: gemini=${JSON.stringify(facts.budgetLakh)} mine=${JSON.stringify(mine.budgetLakh)}`);
  log(`${t.id}  ${ok ? "AGREE   " : "DISAGREE"} expected=${fx.expected.padEnd(9)} verdict=${d.verdict} (after ${turnsUsed} of ${callerIdx.length} caller turns)${d.flags.length ? "  (flags: " + d.flags.length + ")" : ""}`);
  for (const x of dif) log(`        - ${x}`);
  if (dif.length) diffs.push(t.id);
  return lines;
}
for (let i = 0; i < todo.length; i += 4) {
  const out = await Promise.all(todo.slice(i, i + 4).map((t) => one(t).catch((e) => [`${t.id}  ERROR ${(e as Error).message}`])));
  for (const l of out.flat()) console.log(l);
}
const cost = totalCost(geminiCost(inTok, outTok));
console.log(`\n${agree}/${total} verdicts agree. ${diffs.length} calls differ from my hand-extracted facts: ${diffs.join(", ") || "none"}`);
console.log(`Tokens: ${inTok} in / ${outTok} out  (about Rs ${cost.inr.toFixed(2)} for ${total} calls, ${reads} model reads)`);
