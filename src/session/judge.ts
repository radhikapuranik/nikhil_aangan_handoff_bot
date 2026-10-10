import { evaluate } from "../core/qualify.ts";
import type { AskedCounts, CallFacts, Decision } from "../core/types.ts";
import type { TranscriptTurn } from "../db/types.ts";
import type { LlmService, Usage } from "../integrations/types.ts";

// Reads a finished (or partial) conversation the way a live call would: after
// each caller turn, keeping earlier facts, and judging the final state of the call. Used after the call by the finaliser, and by the live-Gemini test.
export async function judgeConversation(
  llm: LlmService, turns: TranscriptTurn[], today: Date, prior: CallFacts | null = null,
): Promise<{ facts: CallFacts | null; decision: Decision | null; usage: Usage; reads: number; turnsUsed: number }> {
  const usage: Usage = { inputTokens: 0, outputTokens: 0 };
  const callerIdx = turns.map((t, i) => (t.speaker === "caller" ? i : -1)).filter((i) => i >= 0);
  const asked: AskedCounts = {};
  let facts: CallFacts | null = prior;
  let decision: Decision | null = null;
  let reads = 0, turnsUsed = 0;
  for (const idx of callerIdx) {
    const r = await llm.extractFacts(turns.slice(0, idx + 1), facts);
    usage.inputTokens += r.usage.inputTokens; usage.outputTokens += r.usage.outputTokens; reads++; turnsUsed++;
    facts = r.facts;
    decision = evaluate(facts, asked, today);
    if (decision.verdict === "needs_followup") { asked[decision.ask!] = (asked[decision.ask!] ?? 0) + 1; continue; }
    // Vaani's agent keeps talking after a decline, and the caller can change their mind (a higher budget,
    // a new location). So keep reading to the end and judge the final picture. Only an existing-client
    // escalation is final straight away.
    if (decision.verdict === "escalated") break;
  }
  // The conversation ended with questions unanswered: treat them as asked, so the
  // call ends in a verdict (qualified with a flag) instead of staying "needs follow-up".
  for (let i = 0; i < 12 && facts && decision && decision.verdict === "needs_followup"; i++) {
    asked[decision.ask!] = (asked[decision.ask!] ?? 0) + 1;
    decision = evaluate(facts, asked, today);
  }
  return { facts, decision, usage, reads, turnsUsed };
}
