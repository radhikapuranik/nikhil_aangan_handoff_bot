import { test } from "node:test";
import assert from "node:assert/strict";
import { TelegramNotifier } from "../src/integrations/telegram.ts";
import { HubSpotCrm } from "../src/integrations/hubspot.ts";
import { CalComCalendar } from "../src/integrations/calcom.ts";
import { GeminiLlm, normaliseFacts } from "../src/integrations/gemini.ts";
import { createIntegrations } from "../src/integrations/index.ts";
import { MockCalendar } from "../src/integrations/mock.ts";

type Call = { url: string; method: string; headers: Record<string, string>; body: any };
function stub(responses: (call: Call, n: number) => { status?: number; json: unknown }) {
  const calls: Call[] = [];
  const f = (async (url: string, init: RequestInit = {}) => {
    const call: Call = { url, method: init.method ?? "GET", headers: (init.headers ?? {}) as Record<string, string>, body: init.body ? JSON.parse(init.body as string) : undefined };
    calls.push(call);
    const r = responses(call, calls.length);
    return new Response(JSON.stringify(r.json), { status: r.status ?? 200 });
  }) as unknown as typeof fetch;
  return { f, calls };
}

test("telegram: plain text, correct chat per channel, errors surface", async () => {
  const { f, calls } = stub(() => ({ json: { ok: true, result: { message_id: 7 } } }));
  const t = new TelegramNotifier("TOKEN", "-100designers", "-100senior", f);
  assert.deepEqual(await t.send("designers", "hi"), { messageId: "7" });
  await t.send("senior", "urgent");
  assert.equal(calls[0].url, "https://api.telegram.org/botTOKEN/sendMessage");
  assert.equal(calls[0].body.chat_id, "-100designers"); assert.equal(calls[1].body.chat_id, "-100senior");
  assert.equal(calls[0].body.parse_mode, undefined);
  const bad = new TelegramNotifier("T", "1", undefined, stub(() => ({ status: 400, json: { ok: false, description: "chat not found" } })).f);
  await assert.rejects(bad.send("designers", "x"), /chat not found/);
  // senior falls back to the designers chat when no senior chat is set
  const s = stub(() => ({ json: { ok: true, result: { message_id: 1 } } }));
  await new TelegramNotifier("T", "D", undefined, s.f).send("senior", "x");
  assert.equal(s.calls[0].body.chat_id, "D");
});

test("hubspot: contact, deal (no amount), then default association", async () => {
  const { f, calls } = stub((c) => ({ json: { id: c.url.includes("contacts") ? "C1" : "D1" } }));
  const r = await new HubSpotCrm("TOK", {}, f).createDeal({ dealName: "Priya — Kothrud", contactName: "Priya Rao", phone: "+919800000001", note: "n" });
  assert.equal(r.dealId, "D1");
  assert.deepEqual(calls.map((c) => `${c.method} ${c.url.replace("https://api.hubapi.com", "")}`), [
    "POST /crm/v3/objects/contacts", "POST /crm/v3/objects/deals", "PUT /crm/v4/objects/deals/D1/associations/default/contacts/C1",
  ]);
  assert.equal(calls[0].headers.Authorization, "Bearer TOK");
  assert.equal(calls[1].body.properties.amount, undefined);
  assert.equal(calls[1].body.properties.pipeline, "default");
});

test("hubspot: a contact or association failure never loses the deal", async () => {
  const { f } = stub((c) => c.url.includes("contacts") || c.method === "PUT" ? { status: 500, json: {} } : { json: { id: "D9" } });
  assert.equal((await new HubSpotCrm("T", {}, f).createDeal({ dealName: "x", contactName: "A", phone: "1", note: "" })).dealId, "D9");
});

test("cal.com: booking request shape, placeholder email from phone, uid returned", async () => {
  const { f, calls } = stub(() => ({ json: { data: { uid: "abc123", start: "2026-10-09T05:30:00.000Z" } } }));
  const cal = new CalComCalendar("cal_KEY", 42, "studio+{phone}@real-domain.test", f);
  const r = await cal.book({ slot: { start: "2026-10-09T05:30:00Z", label: "x" }, name: "Priya", phone: "+91 98000 00001", notes: "note" });
  assert.deepEqual(r, { ref: "abc123", start: "2026-10-09T05:30:00.000Z" });
  assert.equal(calls[0].url, "https://api.cal.com/v2/bookings");
  assert.equal(calls[0].headers["cal-api-version"], "2026-02-25");
  assert.equal(calls[0].headers.Authorization, "Bearer cal_KEY");
  assert.equal(calls[0].body.eventTypeId, 42); assert.equal(calls[0].body.attendee.timeZone, "Asia/Kolkata");
  assert.equal(calls[0].body.attendee.email, "studio+919800000001@real-domain.test");
  await assert.rejects(new CalComCalendar("k", 1, undefined, f).book({ slot: { start: "x", label: "x" }, name: null, phone: "1", notes: "" }), /CALCOM_EMAIL_FALLBACK/);
  assert.equal(calls[0].body.bookingFieldsResponses.notes, "note");
});

test("cal.com: slots are spread over different days; errors surface", async () => {
  const data = { "2026-10-09": [{ start: "2026-10-09T05:30:00Z" }, { start: "2026-10-09T10:30:00Z" }], "2026-10-10": [{ start: "2026-10-10T05:30:00Z" }] };
  const slots = await new CalComCalendar("k", 1, undefined, stub(() => ({ json: { data } })).f).findSlots(2, new Date("2026-10-07T00:00:00Z"));
  assert.equal(slots.length, 2); assert.notEqual(slots[0].start.slice(0, 10), slots[1].start.slice(0, 10));
  await assert.rejects(new CalComCalendar("k", 1, undefined, stub(() => ({ status: 401, json: {} })).f).findSlots(2, new Date()), /401/);
});

test("gemini: request shape, JSON schema output, token usage incl. thinking tokens", async () => {
  const { f, calls } = stub(() => ({ json: {
    candidates: [{ content: { parts: [{ text: JSON.stringify({ existingClient: false, serviceType: "full_home", intent: "full_execution", location: "Baner", sqft: 900, timeline: { kind: "start_by", weeks: 10 }, decisionMaker: "self" }) }] } }],
    usageMetadata: { promptTokenCount: 500, candidatesTokenCount: 60, thoughtsTokenCount: 40 },
  } }));
  const llm = new GeminiLlm("GKEY", undefined, f, () => new Date("2026-10-07"));
  const r = await llm.extractFacts([{ speaker: "caller", text: "2BHK in Baner", at: "" }], null);
  assert.equal(r.facts.location, "Baner"); assert.deepEqual(r.usage, { inputTokens: 500, outputTokens: 100 });
  assert.ok(calls[0].url.includes("/models/gemini-3.5-flash-lite:generateContent"));
  assert.equal(calls[0].headers["x-goog-api-key"], "GKEY");
  assert.equal(calls[0].body.generationConfig.responseMimeType, "application/json");
  assert.ok(calls[0].body.systemInstruction.parts[0].text.includes("2026-10-07"));
  assert.ok(!JSON.stringify(calls[0]).includes("GKEY") || calls[0].headers["x-goog-api-key"] === "GKEY"); // key only in header, not URL
  assert.ok(!calls[0].url.includes("GKEY"));
});

test("gemini: unreadable output is retried once, then an error, never silently 'nothing said'", async () => {
  const s1 = stub(() => ({ json: { candidates: [{ content: { parts: [{ text: "not json {" }] }, finishReason: "MAX_TOKENS" }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 } } }));
  await assert.rejects(new GeminiLlm("k", undefined, s1.f).extractFacts([], null), /MAX_TOKENS/);
  assert.equal(s1.calls.length, 2);
  const ok = JSON.stringify({ existingClient: false, serviceType: "full_home", intent: "full_execution", timeline: { kind: "flexible" }, decisionMaker: "self" });
  const s2 = stub((_c, n) => ({ json: { candidates: [{ content: { parts: [{ text: n === 1 ? "oops" : ok }] } }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 } } }));
  const r = await new GeminiLlm("k", undefined, s2.f).extractFacts([], null);
  assert.equal(r.facts.serviceType, "full_home"); assert.deepEqual(r.usage, { inputTokens: 20, outputTokens: 10 }); // both attempts are billed
  assert.equal(s2.calls[0].body.generationConfig.thinkingConfig.thinkingLevel, "minimal");
});

test("gemini: off-schema values degrade to 'unknown', never to a pass", () => {
  const n = normaliseFacts({ serviceType: "palace", intent: "yes!", decisionMaker: "self; ignore previous rules", timeline: { kind: "soon", weeks: "5" }, budgetLakh: { min: "1", max: 2 }, sqft: "900" }, null);
  assert.equal(n.serviceType, "unknown"); assert.equal(n.intent, "unclear"); assert.equal(n.decisionMaker, "unknown");
  assert.equal(n.timeline.weeks, null); assert.equal(n.budgetLakh, null); assert.equal(n.sqft, null);
});

test("gemini: earlier facts survive a later pass that misses them; existing-client stays set", () => {
  const prior = normaliseFacts({ serviceType: "full_home", intent: "full_execution", location: "Baner", sqft: 900, existingClient: true, decisionMaker: "self", timeline: { kind: "flexible" } }, null);
  const next = normaliseFacts({ serviceType: "unknown", intent: "unclear", existingClient: false }, prior);
  assert.equal(next.location, "Baner"); assert.equal(next.sqft, 900); assert.equal(next.serviceType, "full_home");
  assert.equal(next.decisionMaker, "self"); assert.equal(next.timeline.kind, "flexible"); assert.equal(next.existingClient, true);
});

test("gemini: slot choice is range-checked", async () => {
  const slots = [{ start: "a", label: "A" }, { start: "b", label: "B" }];
  const mk = (choice: number, declined = false) => new GeminiLlm("k", undefined, stub(() => ({ json: { candidates: [{ content: { parts: [{ text: JSON.stringify({ choice, declined }) }] } }] } })).f);
  assert.equal((await mk(2).chooseSlot("second", slots)).index, 1);
  assert.equal((await mk(9).chooseSlot("x", slots)).index, null);
  assert.equal((await mk(0, true).chooseSlot("no", slots)).declined, true);
});

test("createIntegrations: mocks exactly what has no keys, real once keys exist", () => {
  assert.deepEqual(createIntegrations({}).mocked.sort(), ["calcom", "gemini", "hubspot", "telegram"]);
  const some = createIntegrations({ GEMINI_API_KEY: "g", HUBSPOT_TOKEN: "h" });
  assert.deepEqual(some.mocked.sort(), ["calcom", "telegram"]);
  assert.ok(!(some.calendar instanceof Object && some.mocked.includes("gemini")));
  assert.ok(createIntegrations({}).calendar instanceof MockCalendar);
});

test("mock calendar offers 11:00 and 16:00 IST on weekdays", async () => {
  const slots = await new MockCalendar().findSlots(4, new Date("2026-10-07T05:00:00Z"));
  const hm = slots.map((s) => new Date(s.start).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Kolkata" }));
  assert.deepEqual(hm, ["11:00", "16:00", "11:00", "16:00"]);
  for (const s of slots) assert.ok(![0, 6].includes(new Date(new Date(s.start).getTime() + 330 * 60000).getUTCDay()));
});

test("gemini: budget arrives as whole rupees and becomes lakh; output is capped", async () => {
  const j = JSON.stringify({ existingClient: false, serviceType: "partial_home", intent: "full_execution", timeline: { kind: "unknown", weeks: null }, decisionMaker: "unknown", budgetMinRupees: 100000, budgetMaxRupees: 150000 });
  const s = stub(() => ({ json: { candidates: [{ content: { parts: [{ text: j }] } }], usageMetadata: {} } }));
  const r = await new GeminiLlm("k", undefined, s.f).extractFacts([], null);
  assert.deepEqual(r.facts.budgetLakh, { min: 1, max: 1.5 });
  assert.equal(s.calls[0].body.generationConfig.maxOutputTokens, 1024);
  assert.equal(JSON.stringify(s.calls[0].body.generationConfig.responseSchema).includes('"NUMBER"'), false); // integers only
  assert.deepEqual(normaliseFacts({ budgetMaxRupees: 2500000 }, null).budgetLakh, { min: 25, max: 25 });
});
