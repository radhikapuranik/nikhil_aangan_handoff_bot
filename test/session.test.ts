import { test } from "node:test";
import assert from "node:assert/strict";
import { MemoryRepository } from "../src/db/memory.ts";
import { CallSession, type SessionDeps } from "../src/session/call-session.ts";
import { MockCalendar, MockCrm, MockLlm, MockNotifier } from "../src/integrations/mock.ts";
import type { LlmService } from "../src/integrations/types.ts";
import type { CallFacts } from "../src/core/types.ts";
import { DECLINE_SCRIPT, PRICING_DEFLECTION, ESCALATION_SCRIPT } from "../src/core/scripts.ts";
import { FAQ_ANSWERS } from "../src/core/faq.ts";
import { DEFAULT_RATES } from "../src/core/costs.ts";
import { PHONE_FIXTURES } from "../src/fixtures/phone-transcripts.ts";

const fixture = (id: string) => PHONE_FIXTURES.find((f) => f.id === id)!.facts as CallFacts;
const NOW = new Date("2026-10-07T05:00:00Z"); // 10:30 IST

// Plays back one set of facts per caller turn, so tests control exactly what
// "the model understood". Everything else comes from MockLlm.
function scripted(steps: CallFacts[], over: Partial<LlmService> = {}): LlmService {
  const mock = new MockLlm();
  return {
    triage: (u) => mock.triage(u),
    chooseSlot: (u, s) => mock.chooseSlot(u, s),
    extractFacts: async (t) => {
      const n = t.filter((x) => x.speaker === "caller").length;
      return { facts: steps[Math.min(n, steps.length) - 1], usage: { inputTokens: 1000, outputTokens: 100 } };
    },
    ...over,
  };
}

async function setup(steps: CallFacts[], over: Partial<LlmService> = {}) {
  const repo = new MemoryRepository();
  const calendar = new MockCalendar(), notifier = new MockNotifier(), crm = new MockCrm();
  const deps: SessionDeps = { repo, llm: scripted(steps, over), calendar, notifier, crm, now: () => NOW, rates: { ...DEFAULT_RATES, vaaniPerMinuteInr: null } };
  const { session, greeting } = await CallSession.start(deps, { providerCallId: "c1", startedAt: NOW.toISOString(), answerLatencyMs: 900, callerPhone: "+919800000001" });
  return { repo, calendar, notifier, crm, session, greeting };
}
const end = (s: CallSession) => s.finish({ endedAt: NOW.toISOString(), durationSec: 240 });

test("greets with the spec opening line and logs the call at answer time", async () => {
  const { greeting, repo } = await setup([fixture("T01")]);
  assert.equal(greeting, "Good morning, Aangan Studio — how can I help you today?");
  assert.equal(repo.calls.size, 1);
});

test("qualified call: books in-call, sends handoff with the booking, creates the deal", async () => {
  const { session, repo, calendar, notifier, crm } = await setup([fixture("T01")]);
  const r1 = await session.hear("We have a 3BHK in Kothrud and want to redo the whole thing.");
  assert.equal(r1.end, false); assert.ok(r1.say.includes("book your consultation"));
  const r2 = await session.hear("The first one please");
  assert.equal(r2.end, true); assert.ok(r2.say.startsWith("You're booked for"));
  const rec = await end(session);
  assert.equal(rec.verdict, "qualified"); assert.equal(rec.bookingStatus, "booked");
  assert.equal(rec.handoffStatus, "sent"); assert.equal(rec.crmStatus, "created"); assert.equal(rec.crmDealId, "deal-1");
  assert.equal(calendar.booked.length, 1);
  assert.equal(notifier.sent[0].channel, "designers");
  assert.ok(notifier.sent[0].text.includes("Consultation booked: YES"));
  assert.ok(notifier.sent[0].text.includes("Kothrud"));
  assert.equal(crm.deals.length, 1);
  assert.equal(repo.costs.some((c) => c.service === "gemini"), true);
  assert.equal(repo.costs.find((c) => c.service === "vaani")!.costInr, null); // rate unknown, never zero
});

test("pricing question gets the verbatim deflection and does not skip the pending question", async () => {
  const noDm = { ...fixture("T01"), decisionMaker: "unknown" as const, decisionMakerNote: null };
  const yes = fixture("T01");
  const { session, notifier } = await setup([noDm, noDm, yes]);
  const r1 = await session.hear("How much would a full redesign cost? Can you give me a ballpark?");
  assert.equal(r1.say, PRICING_DEFLECTION);
  const r2 = await session.hear("Okay.");
  assert.ok(r2.say.includes("Will you be the one deciding"), r2.say); // asked now, not skipped
  const r3 = await session.hear("Yes, I'm the owner and I decide.");
  assert.ok(r3.say.includes("book your consultation"));
  const rec = await end(session);
  assert.equal(rec.pricingAsked, true); assert.equal(rec.verdict, "qualified");
  assert.equal(notifier.sent.length, 1);
});

test("pricing rephrased repeatedly always yields the identical verbatim line", async () => {
  const noDm = { ...fixture("T01"), decisionMaker: "unknown" as const };
  const { session } = await setup([noDm]);
  for (const q of ["what's the rate per sq ft?", "just a rough range please", "come on, even a ballpark", "kitna kharcha aayega"]) {
    assert.equal((await session.hear(q)).say, PRICING_DEFLECTION, q);
  }
});

test("out-of-area caller who also asks the price gets the decline script, not the deflection", async () => {
  const { session, notifier, crm } = await setup([fixture("T03")]);
  const r = await session.hear("I'm in Nashik. How much would it cost?");
  assert.equal(r.say, DECLINE_SCRIPT); assert.equal(r.end, true);
  const rec = await end(session);
  assert.equal(rec.verdict, "declined"); assert.equal(rec.handoffStatus, "not_applicable");
  assert.equal(notifier.sent.length, 0); assert.equal(crm.deals.length, 0);
});

test("existing client: escalates to the senior channel, never declined", async () => {
  const { session, notifier } = await setup([fixture("T09")]);
  const r = await session.hear("My project has been going for three months and my designer hasn't replied in five days.");
  assert.equal(r.say, ESCALATION_SCRIPT);
  const rec = await end(session);
  assert.equal(rec.verdict, "escalated"); assert.equal(rec.handoffStatus, "escalation_pending");
  assert.equal(notifier.sent[0].channel, "senior"); assert.ok(notifier.sent[0].text.includes("15 minutes"));
});

test("deferred call is logged with the honest start window and no handoff", async () => {
  const { session, notifier } = await setup([fixture("T07")]);
  const r = await session.hear("I want my living room and kitchen done before Diwali.");
  assert.ok(r.say.includes("at least six weeks")); assert.equal(r.end, true);
  const rec = await end(session);
  assert.equal(rec.verdict, "deferred"); assert.equal(notifier.sent.length, 0);
});

test("general services question is answered from the fixed FAQ, then qualifying continues", async () => {
  const blank: CallFacts = { ...fixture("T16"), callerName: null, location: null, serviceType: "unknown" };
  const { session } = await setup([blank]);
  const r = await session.hear("What areas do you work in?");
  assert.equal(r.say, FAQ_ANSWERS.service_area); assert.equal(r.end, false);
});

test("calendar failure: caller is told the designer will call; handoff and deal still happen", async () => {
  const { session, calendar, notifier, crm } = await setup([fixture("T01")]);
  await session.hear("full redesign in Kothrud");
  calendar.failNext = true;
  const r = await session.hear("first one");
  assert.ok(r.say.includes("call you to confirm")); assert.equal(r.end, true);
  const rec = await end(session);
  assert.equal(rec.bookingStatus, "failed"); assert.equal(rec.handoffStatus, "sent"); assert.equal(rec.crmStatus, "created");
  assert.ok(notifier.sent[0].text.includes("Consultation booked: no")); assert.equal(crm.deals.length, 1);
});

test("caller hangs up while slots are offered: lead is still handed off and logged", async () => {
  const { session, notifier } = await setup([fixture("T01")]);
  await session.hear("full redesign in Kothrud");
  const rec = await end(session);
  assert.equal(rec.verdict, "qualified"); assert.equal(rec.bookingStatus, "offered"); assert.equal(rec.handoffStatus, "sent");
  assert.ok(notifier.sent[0].text.includes("Consultation booked: no"));
});

test("caller declines the slots: no booking, lead still forwarded", async () => {
  const { session } = await setup([fixture("T01")]);
  await session.hear("full redesign in Kothrud");
  const r = await session.hear("No, not now.");
  assert.equal(r.end, true);
  const rec = await end(session);
  assert.equal(rec.bookingStatus, "declined_by_caller"); assert.equal(rec.handoffStatus, "sent");
});

test("Telegram and HubSpot failures are recorded as failed, never swallowed or fatal", async () => {
  const { session, notifier, crm, repo } = await setup([fixture("T01")]);
  notifier.fail = true; crm.fail = true;
  await session.hear("full redesign in Kothrud"); await session.hear("first one");
  const rec = await end(session);
  assert.equal(rec.verdict, "qualified"); assert.equal(rec.handoffStatus, "failed"); assert.equal(rec.crmStatus, "failed");
  assert.equal(repo.calls.size, 1);
});

test("hang-up before any decision is logged as abandoned", async () => {
  const { session } = await setup([fixture("T01")]);
  const rec = await end(session);
  assert.equal(rec.verdict, "abandoned");
});

test("an LLM failure mid-call does not lose the call record", async () => {
  const { session, repo } = await setup([fixture("T01")], { extractFacts: async () => { throw new Error("gemini down"); } });
  await assert.rejects(session.hear("hello"), /gemini down/);
  const rec = await end(session);
  assert.equal(rec.verdict, "abandoned"); assert.equal(repo.calls.size, 1);
});
