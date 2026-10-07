import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluate } from "../src/core/qualify.ts";
import { guardSpeech, isPricingQuestion, violatesPricingRule } from "../src/core/pricing.ts";
import { DECLINE_SCRIPT, PRICING_DEFLECTION, openingLine } from "../src/core/scripts.ts";
import { buildHandoffNote } from "../src/core/handoff.ts";
import type { CallFacts } from "../src/core/types.ts";
import { PHONE_FIXTURES } from "../src/fixtures/phone-transcripts.ts";
import { runFixture } from "../src/fixtures/harness.ts";

const good: CallFacts = {
  existingClient: false, serviceType: "full_home", intent: "full_execution",
  location: "Baner", sqft: 1000, rooms: null, currentState: "bare shell",
  timeline: { kind: "start_by", weeks: 12 }, decisionMaker: "self", budgetLakh: null,
};
const withF = (p: Partial<CallFacts>) => ({ ...good, ...p });
const today = new Date("2026-10-07");

test("scripts are verbatim from the spec", () => {
  assert.equal(PRICING_DEFLECTION, "Pricing depends on the site, the materials you choose, and the scope — your designer will walk you through it in detail at the consultation. I can book that for you right now if you'd like.");
  assert.equal(DECLINE_SCRIPT, "This sounds like it may not be the right fit for us right now — but feel free to reach out if your timeline or scope changes.");
  assert.equal(openingLine(9), "Good morning, Aangan Studio — how can I help you today?");
  assert.equal(openingLine(14), "Good afternoon, Aangan Studio — how can I help you today?");
  assert.equal(openingLine(22), "Good evening, Aangan Studio — how can I help you today?");
});

test("pricing questions are detected however they are phrased", () => {
  for (const q of ["how much do you charge per sq ft for a 2bhk?", "what's your rate?", "can you give me a rough ballpark", "Can you email me the price list?", "kitna kharcha aayega", "even a range?? what would it cost"]) {
    assert.ok(isPricingQuestion(q), q);
  }
  for (const q of ["just a rough range please", "even a number would help", "can you give me a ballpark", "any rough idea of the cost", "can't you give me even a rough range?", "what are your starting prices"])
    assert.ok(isPricingQuestion(q), q);
  assert.ok(!isPricingQuestion("My budget is 20 lakh for the full home."));
  for (const q of ["It's roughly 950 sq ft carpet.", "We have a range of rooms to do", "About 1,400 sq ft", "I'd like it done by March", "we moved in two years ago"])
    assert.ok(!isPricingQuestion(q), "false positive: " + q);
  assert.ok(!isPricingQuestion("I have a 3BHK in Baner."));
});

test("guard blocks any number, range or per-sq-ft figure in agent speech", () => {
  for (const s of ["It'll cost around 12 lakh.", "Our rates start at ₹1,800 per sq ft.", "For a 2BHK it's typically Rs 8 lakh", "about 2,000 per sqft", "₹3.5 lakh – ₹8 lakh"]) {
    assert.ok(violatesPricingRule(s), s);
    assert.deepEqual(guardSpeech(s), { text: PRICING_DEFLECTION, replaced: true });
  }
  for (const s of [DECLINE_SCRIPT, PRICING_DEFLECTION, "The earliest we could realistically start is around 18 November 2026.", "That's a 1,400 square foot flat, lovely."]) {
    assert.equal(guardSpeech(s).replaced, false, s);
  }
});

test("existing client always escalates and skips qualification, even with failing facts", () => {
  const d = evaluate(withF({ existingClient: true, location: "Mumbai", intent: "advice_only" }), {}, today);
  assert.equal(d.verdict, "escalated");
  assert.equal(d.checks, null);
});

test("out-of-scope service types decline immediately without the checklist", () => {
  for (const t of ["restaurant", "hotel", "retail", "gym", "architecture_structural", "decor_only", "furniture_only", "vastu_only"] as const) {
    const d = evaluate(withF({ serviceType: t }), {}, today);
    assert.equal(d.verdict, "declined", t);
    assert.equal(d.checks, null);
    assert.equal(d.say, DECLINE_SCRIPT);
  }
});

test("hard out-of-area locations decline", () => {
  for (const l of ["Talegaon Dabhade", "Lonavala", "Nashik", "Mumbai", "Nagpur"])
    assert.equal(evaluate(withF({ location: l }), {}, today).verdict, "declined", l);
});

test("listed and adjoining Pune areas pass", () => {
  for (const l of ["Pimple Saudagar", "Hinjewadi Phase 1", "NIBM Road", "Kharadi", "Nanded City"])
    assert.equal(evaluate(withF({ location: l }), {}, today).checks?.c2, "pass", l);
});

test("unrecognised place asks once, then a follow-up, then goes forward flagged", () => {
  const f = withF({ location: "Zorbaville township" });
  const a = evaluate(f, {}, today);
  assert.equal(a.verdict, "needs_followup"); assert.equal(a.ask, "c2");
  const b = evaluate(f, { c2: 1 }, today);
  assert.equal(b.verdict, "needs_followup"); assert.ok(b.say!.includes("Pimpri-Chinchwad"));
  const c = evaluate(f, { c2: 2 }, today);
  assert.equal(c.verdict, "qualified"); assert.ok(c.flags.some((x) => x.includes("Location")));
});

test("timeline: 6 weeks passes, 5 weeks defers with an honest start date", () => {
  assert.equal(evaluate(withF({ timeline: { kind: "start_by", weeks: 6 } }), {}, today).verdict, "qualified");
  const d = evaluate(withF({ timeline: { kind: "complete_by", weeks: 5 } }), {}, today);
  assert.equal(d.verdict, "deferred");
  assert.equal(d.earliestStart, "18 November 2026");
});

test("timeline fail plus another fail declines instead of deferring", () => {
  const d = evaluate(withF({ timeline: { kind: "complete_by", weeks: 3 }, budgetLakh: { min: 1, max: 1.5 } }), {}, today);
  assert.equal(d.verdict, "declined");
});

test("budget: never required; clearly low declines; borderline forwards with a flag", () => {
  assert.equal(evaluate(good, {}, today).verdict, "qualified");
  assert.equal(evaluate(withF({ budgetLakh: { min: 1, max: 1.5 } }), {}, today).verdict, "declined");
  const b = evaluate(withF({ sqft: 1000, budgetLakh: { min: 12, max: 14 } }), {}, today); // floor 18, 60% = 10.8
  assert.equal(b.verdict, "qualified");
  assert.ok(b.flags.some((x) => x.includes("budget")));
  assert.equal(evaluate(withF({ budgetLakh: { min: 25, max: 30 } }), {}, today).flags.length, 0);
});

test("decision-maker unclear is asked once, never pushed, forwarded flagged", () => {
  const f = withF({ decisionMaker: "research_only", decisionMakerNote: "doing research for in-laws" });
  const a = evaluate(f, {}, today);
  assert.equal(a.verdict, "needs_followup"); assert.equal(a.ask, "c5");
  const b = evaluate(f, { c5: 1 }, today);
  assert.equal(b.verdict, "qualified"); assert.ok(b.flags.some((x) => x.includes("Decision-maker")));
});

test("represented decision-makers pass", () => {
  for (const dm of ["self", "authorised", "family_attending"] as const)
    assert.equal(evaluate(withF({ decisionMaker: dm }), {}, today).checks?.c5, "pass", dm);
});

test("advice-only declines; unclear intent probes once", () => {
  assert.equal(evaluate(withF({ intent: "advice_only" }), {}, today).verdict, "declined");
  const d = evaluate(withF({ intent: "unclear" }), {}, today);
  assert.equal(d.verdict, "needs_followup"); assert.equal(d.ask, "c1");
});

test("commercial size limits", () => {
  const c = (sqft: number) => evaluate(withF({ serviceType: "commercial_office", sqft }), {}, today).verdict;
  assert.equal(c(499), "declined"); assert.equal(c(500), "qualified");
  assert.equal(c(3000), "qualified"); assert.equal(c(3500), "declined");
});

test("a pricing question never changes the verdict (it is not a check)", () => {
  assert.equal(evaluate(good, {}, today).verdict, "qualified");
});

test("handoff note carries every field from the spec", () => {
  const f = withF({ callerName: "Priya", phone: "+91 98xxxxxx01", decisionMaker: "authorised", decisionMakerNote: "husband agrees" });
  const note = buildHandoffNote(f, evaluate(f, {}, today), { booked: true, when: "Mon 13 Oct 11:00" });
  for (const s of ["Priya", "+91 98xxxxxx01", "full home", "Baner", "1000 sq ft", "bare shell", "Timeline:", "Budget signal:", "Decision-maker:", "Uncertainty flags:", "Consultation booked: YES — Mon 13 Oct 11:00"])
    assert.ok(note.includes(s), s);
});

test("T01-T20 transcripts all agree with expected verdicts", () => {
  for (const fx of PHONE_FIXTURES) {
    const r = runFixture(fx);
    assert.ok(r.match, `${fx.id}: expected ${fx.expected}, got ${r.actual}`);
    assert.ok(r.pricingOk, `${fx.id}: pricing question missed`);
  }
});
