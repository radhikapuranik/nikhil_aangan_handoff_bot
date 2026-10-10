import { test } from "node:test";
import assert from "node:assert/strict";
import { judgeConversation } from "../src/session/judge.ts";
import type { CallFacts } from "../src/core/types.ts";
import type { LlmService } from "../src/integrations/types.ts";

const base: CallFacts = { existingClient: false, serviceType: "commercial_office", intent: "full_execution", location: "Shivaji Nagar", sqft: null, rooms: null, currentState: null, timeline: { kind: "complete_by", weeks: 30 }, decisionMaker: "self", budgetLakh: null };
const turns = (n: number) => Array.from({ length: n }, (_, i) => ({ speaker: i % 2 ? "agent" : "caller", text: "x", at: "" })) as any[];
const llm = (byCallerTurn: Partial<CallFacts>[]): LlmService => ({
  triage: async () => ({ route: "qualify", usage: { inputTokens: 0, outputTokens: 0 } }),
  chooseSlot: async () => ({ index: null, declined: false, usage: { inputTokens: 0, outputTokens: 0 } }),
  extractFacts: async (t) => { const n = t.filter((x) => x.speaker === "caller").length; return { facts: { ...base, ...byCallerTurn[Math.min(n, byCallerTurn.length) - 1] }, usage: { inputTokens: 1, outputTokens: 1 } }; },
});

test("a caller who raises a too-low budget later in the call is judged on the final budget", async () => {
  const r = await judgeConversation(llm([{ budgetLakh: { min: 0.7, max: 0.7 } }, {}, { budgetLakh: { min: 5, max: 5 } }]), turns(6), new Date("2026-10-10"));
  assert.equal(r.decision!.verdict, "qualified");
});

test("a budget that stays too low still declines", async () => {
  const r = await judgeConversation(llm([{ budgetLakh: { min: 0.7, max: 0.7 } }]), turns(6), new Date("2026-10-10"));
  assert.equal(r.decision!.verdict, "declined");
});

test("an existing-client call is final immediately", async () => {
  const r = await judgeConversation(llm([{ existingClient: true }, { existingClient: false }]), turns(6), new Date("2026-10-10"));
  assert.equal(r.decision!.verdict, "escalated"); assert.equal(r.turnsUsed, 1);
});
