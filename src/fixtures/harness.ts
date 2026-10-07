import { evaluate } from "../core/qualify.ts";
import { isPricingQuestion } from "../core/pricing.ts";
import type { AskedCounts, Decision } from "../core/types.ts";
import type { Expected, Fixture } from "./phone-transcripts.ts";

export interface FixtureResult {
  id: string;
  expected: Expected;
  actual: Expected | "needs_followup";
  finalDecision: Decision | null;
  questionsStillOpen: string[]; // what the agent would still ask live
  pricingOk: boolean;
  match: boolean;
}

// Run the engine the way a live call would. Whenever it wants to ask a
// question the transcript never answers, record that and mark it asked with no
// new information, until it reaches a final verdict.
export function runFixture(fx: Fixture, today = new Date("2026-09-01")): FixtureResult {
  const pricingOk = (fx.pricingQuestions ?? []).every(isPricingQuestion);
  if (!fx.facts) {
    return { id: fx.id, expected: fx.expected, actual: "ops_failure", finalDecision: null, questionsStillOpen: [], pricingOk, match: fx.expected === "ops_failure" };
  }
  const asked: AskedCounts = {};
  const open: string[] = [];
  let d = evaluate(fx.facts, asked, today);
  for (let i = 0; i < 12 && d.verdict === "needs_followup"; i++) {
    open.push(`${d.ask}: ${d.say}`);
    asked[d.ask!] = (asked[d.ask!] ?? 0) + 1;
    d = evaluate(fx.facts, asked, today);
  }
  return {
    id: fx.id, expected: fx.expected, actual: d.verdict as Expected,
    finalDecision: d, questionsStillOpen: open, pricingOk,
    match: d.verdict === fx.expected,
  };
}
