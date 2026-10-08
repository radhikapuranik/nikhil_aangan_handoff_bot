import { isPricingQuestion, pricingViolationKind } from "./pricing.ts";
import { DECLINE_SCRIPT, PRICING_DEFLECTION } from "./scripts.ts";
import type { TranscriptTurn } from "../db/types.ts";

// When the voice platform's own AI speaks, my code can no longer guarantee the
// words. This checks, after the call, what the agent actually said.

// Wording differences that are not real differences: case, spacing, dash and quote styles.
export const normalise = (s: string) =>
  s.toLowerCase().replace(/[—–\-]+/g, " ").replace(/[‘’']/g, "'").replace(/[^\p{L}\p{N}' ]/gu, " ").replace(/\s+/g, " ").trim();

export type AuditIssue = "price_quoted" | "pricing_line_not_verbatim" | "decline_line_not_verbatim" | "booked_despite_verdict";

const numbersIn = (s: string) => (s.match(/\d[\d,]*\.?\d*/g) ?? []).map((n) => n.replace(/,/g, ""));

// Repeating a figure the caller just said ("1 to 1.5 lakh would be below what
// a project like that needs") is not quoting a price. A rule hit with no
// numbers at all (e.g. "per sq ft") is never an echo.
function quotesPrice(turns: TranscriptTurn[], i: number): boolean {
  const t = turns[i];
  if (t.speaker !== "agent") return false;
  const kind = pricingViolationKind(t.text);
  if (kind === null) return false;
  if (kind === "phrase") return true;
  const nums = numbersIn(t.text);
  if (!nums.length) return true;
  const callerSaid = new Set(turns.slice(0, i).filter((x) => x.speaker === "caller").flatMap((x) => numbersIn(x.text)));
  return !nums.every((n) => callerSaid.has(n));
}

export function auditAgentTurns(turns: TranscriptTurn[], ctx: { verdict: string }): AuditIssue[] {
  const agent = turns.filter((t) => t.speaker === "agent").map((t) => normalise(t.text));
  const issues: AuditIssue[] = [];
  if (turns.some((_, i) => quotesPrice(turns, i))) issues.push("price_quoted");
  const pricingAsked = turns.some((t) => t.speaker === "caller" && isPricingQuestion(t.text));
  if (pricingAsked && !agent.some((a) => a.includes(normalise(PRICING_DEFLECTION)))) issues.push("pricing_line_not_verbatim");
  if (ctx.verdict === "declined" && !agent.some((a) => a.includes(normalise(DECLINE_SCRIPT)))) issues.push("decline_line_not_verbatim");
  return issues;
}

export const ISSUE_TEXT: Record<AuditIssue, string> = {
  price_quoted: "Agent stated a price, range or per-sq-ft figure",
  pricing_line_not_verbatim: "Caller asked about price and the agent did not use the scripted line",
  decline_line_not_verbatim: "Call was declined but the agent did not use the scripted decline line",
  booked_despite_verdict: "A consultation was booked on a call the rules say should not have been forwarded",
};
