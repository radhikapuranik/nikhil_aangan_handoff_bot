import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { MemoryRepository } from "../src/db/memory.ts";
import { MockCalendar, MockCrm, MockLlm, MockNotifier } from "../src/integrations/mock.ts";
import type { LlmService } from "../src/integrations/types.ts";
import type { CallFacts } from "../src/core/types.ts";
import type { SessionDeps } from "../src/session/call-session.ts";
import { createHandler } from "../src/voice/http.ts";
import { parseTranscript } from "../src/voice/vaani-webhook.ts";
import { auditAgentTurns, normalise } from "../src/core/audit.ts";
import { DECLINE_SCRIPT, ESCALATION_SCRIPT, PRICING_DEFLECTION } from "../src/core/scripts.ts";
import { buildAgentInstructions, buildToolsDoc, TOOLS } from "../src/core/vaani-instructions.ts";
import { PHONE_FIXTURES } from "../src/fixtures/phone-transcripts.ts";
import { summarise } from "../src/db/summary.ts";
import { needsAttention } from "../src/db/dashboard.ts";

const fx = (id: string) => PHONE_FIXTURES.find((f) => f.id === id)!.facts as CallFacts;
const NOW = new Date("2026-10-07T05:00:00Z");
const SECRET = "tool-secret", WH = "vv_whk_x";

function build(facts: CallFacts = fx("T01")) {
  const mock = new MockLlm();
  const llm: LlmService = { triage: (u) => mock.triage(u), chooseSlot: (u, s) => mock.chooseSlot(u, s), extractFacts: async () => ({ facts, usage: { inputTokens: 500, outputTokens: 50 } }) };
  const repo = new MemoryRepository(), notifier = new MockNotifier(), crm = new MockCrm(), calendar = new MockCalendar();
  const deps: SessionDeps = { repo, llm, notifier, crm, calendar, now: () => NOW };
  return { repo, notifier, crm, calendar, deps, handle: createHandler(deps, { brainSecret: SECRET, vaaniWebhookSecret: WH }) };
}
const post = (h: (r: Request) => Promise<Response>, path: string, body: object, auth: string | null = SECRET) =>
  h(new Request(`http://x${path}`, { method: "POST", headers: { "content-type": "application/json", ...(auth ? { authorization: `Bearer ${auth}` } : {}) }, body: JSON.stringify(body) }));
const hook = (h: (r: Request) => Promise<Response>, env: object) => {
  const raw = JSON.stringify(env);
  return h(new Request("http://x/webhooks/vaani", { method: "POST", headers: { "x-vaanivoice-signature": "sha256=" + createHmac("sha256", WH).update(raw).digest("hex") }, body: raw }));
};
const turns = (...x: [string, string][]) => x.map(([speaker, text]) => ({ speaker: speaker as "agent" | "caller", text, at: "" }));

test("generated Vaani instructions carry every script verbatim and the hard rules", () => {
  const t = buildAgentInstructions();
  for (const s of [PRICING_DEFLECTION, DECLINE_SCRIPT, ESCALATION_SCRIPT, "Good morning, Aangan Studio — how can I help you today?", "Will you be the one deciding on this, or is someone else involved too?", "Whereabouts is the property?", "What timeline are you working with?"])
    assert.ok(t.includes(s), s);
  assert.ok(t.includes("NEVER ask about budget")); assert.ok(t.includes("Nashik"));
  assert.ok(!t.includes("aangan_desk"), "default prompt must not mention a tool the AI may read aloud");
  assert.ok(t.includes("You cannot book appointments yourself"));
  const withTool = buildAgentInstructions({ useTool: true });
  assert.ok(withTool.includes("@aangan_desk") && withTool.includes(PRICING_DEFLECTION));
  assert.ok(!/₹|lakh per|per sq ?ft rate/i.test(t.replace(/one to one and a half lakh|1 lakh/gi, "")), "instructions must contain no price figure");
  const doc = buildToolsDoc("https://x.test");
  for (const tool of TOOLS) assert.ok(doc.includes(tool.name) && doc.includes("https://x.test" + tool.path));
});

test("audit: flags quoted prices, missing verbatim pricing/decline lines; accepts dash and quote variants", () => {
  assert.deepEqual(auditAgentTurns(turns(["agent", "A 2BHK usually costs around ₹12 lakh."]), { verdict: "qualified" }), ["price_quoted"]);
  const asked = turns(["caller", "how much would it cost?"], ["agent", "It depends, maybe 8 lakh or so"]);
  assert.deepEqual(auditAgentTurns(asked, { verdict: "qualified" }).sort(), ["price_quoted", "pricing_line_not_verbatim"]);
  const ok = turns(["caller", "what is the rate per sq ft?"], ["agent", PRICING_DEFLECTION.replace(" — ", " - ").replace("you'd", "you’d")]);
  assert.deepEqual(auditAgentTurns(ok, { verdict: "qualified" }), []);
  assert.deepEqual(auditAgentTurns(turns(["agent", "Sorry, not a fit."]), { verdict: "declined" }), ["decline_line_not_verbatim"]);
  assert.deepEqual(auditAgentTurns(turns(["agent", DECLINE_SCRIPT]), { verdict: "declined" }), []);
  assert.equal(normalise("Hello — “you’d”"), normalise("hello - you'd"));
});

test("audit: echoing the caller's own budget is not quoting a price, but a new figure is", () => {
  const echo = turns(["caller", "My budget is 1 to 1.5 lakh for everything."], ["agent", "1 to 1.5 lakh would be significantly below what a project of that scope needs."]);
  assert.deepEqual(auditAgentTurns(echo, { verdict: "declined" }), ["decline_line_not_verbatim"]);
  const fresh = turns(["caller", "My budget is 1 to 1.5 lakh."], ["agent", "A project like that starts at 8 lakh."]);
  assert.ok(auditAgentTurns(fresh, { verdict: "qualified" }).includes("price_quoted"));
  const perSqft = turns(["caller", "I have 1400 sq ft"], ["agent", "We charge a rate per sq ft for 1400 sq ft."]);
  assert.ok(auditAgentTurns(perSqft, { verdict: "qualified" }).includes("price_quoted"));
});

test("audit on the real human front-desk transcripts: T02/T13 deflections are not verbatim, as expected", () => {
  // The front desk paraphrased the pricing line, which is why a script check matters.
  const t = turns(["caller", "can you tell me roughly how much that would cost?"], ["agent", "Our pricing depends on the materials and the scope — the best way is a consultation."]);
  assert.deepEqual(auditAgentTurns(t, { verdict: "qualified" }), ["pricing_line_not_verbatim"]);
});

test("parseTranscript accepts the common shapes and ignores junk", () => {
  assert.equal(parseTranscript({ transcript: [{ role: "assistant", content: "Hi" }, { role: "user", content: "Hello" }, { role: "tool", content: "x" }] })!.map((x) => x.speaker).join(), "agent,caller");
  assert.equal(parseTranscript({ messages: [{ speaker: "Caller", text: "hi" }] })![0].speaker, "caller");
  assert.equal(parseTranscript({ transcript: "Agent: Hello there\nCaller: I need a designer" })!.length, 2);
  assert.equal(parseTranscript({ transcript: [] }), null); assert.equal(parseTranscript({}), null); assert.equal(parseTranscript({ transcript: 42 }), null);
});

test("tools require the shared secret", async () => {
  const { handle } = build();
  for (const p of ["/tools/desk", "/tools/qualify", "/tools/availability", "/tools/book"]) {
    assert.equal((await post(handle, p, {}, null)).status, 401, p);
    assert.equal((await post(handle, p, {}, "wrong")).status, 401, p);
  }
});

test("qualify tool: returns the exact decline words, asks the right next question, applies the rules", async () => {
  const { handle, repo } = build();
  const decl = await (await post(handle, "/tools/qualify", { callId: "c1", callerPhone: "+91980", serviceType: "restaurant" })).json() as any;
  assert.equal(decl.verdict, "declined"); assert.equal(decl.say, DECLINE_SCRIPT); assert.ok(decl.instruction.includes("word for word"));
  const q = await (await post(handle, "/tools/qualify", { callId: "c2", serviceType: "full_home", intent: "full_execution", location: "Baner" })).json() as any;
  assert.equal(q.verdict, "needs_followup"); assert.ok(q.say.includes("timeline"));
  const q2 = await (await post(handle, "/tools/qualify", { callId: "c2", timelineKind: "complete_by", timelineWeeks: 20, decisionMaker: "self" })).json() as any;
  assert.equal(q2.verdict, "qualified"); // earlier facts from the first call are kept
  const bad = await (await post(handle, "/tools/qualify", { callId: "c3", serviceType: "full_home", intent: "full_execution", location: "Nashik" })).json() as any;
  assert.equal(bad.verdict, "declined");
  const rec = await repo.getByProviderCallId("c2");
  assert.equal(rec!.facts!.location, "Baner"); assert.equal(rec!.verdict, "in_progress");
});

test("qualify tool: existing client alerts the senior team immediately, once", async () => {
  const { handle, notifier, repo } = build();
  const r1 = await (await post(handle, "/tools/qualify", { callId: "e1", callerName: "Sheetal", existingClient: true })).json() as any;
  const r2 = await (await post(handle, "/tools/qualify", { callId: "e1", existingClient: true })).json() as any;
  assert.equal(r1.verdict, "escalated"); assert.equal(r1.say, ESCALATION_SCRIPT); assert.equal(r2.verdict, "escalated");
  assert.equal(notifier.sent.length, 1); assert.equal(notifier.sent[0].channel, "senior"); assert.ok(notifier.sent[0].text.includes("15 minutes"));
  assert.equal((await repo.getByProviderCallId("e1"))!.handoffStatus, "escalation_pending");
});

test("tool-driven call end to end: qualify, offer slots, book, then the completed webhook sends the handoff", async () => {
  const { handle, repo, notifier, crm, calendar } = build();
  await post(handle, "/tools/qualify", { callId: "v1", callerPhone: "+919800000001", callerName: "Priya", serviceType: "full_home", intent: "full_execution", location: "Kothrud", timelineKind: "complete_by", timelineWeeks: 26, decisionMaker: "authorised" });
  const av = await (await post(handle, "/tools/availability", { callId: "v1" })).json() as any;
  assert.equal(av.slots.length, 2);
  const bk = await (await post(handle, "/tools/book", { callId: "v1", slotStart: av.slots[0].start })).json() as any;
  assert.equal(bk.confirmed, true); assert.equal(calendar.booked.length, 1);
  assert.ok(calendar.booked[0].notes.includes("Kothrud"));
  assert.equal(notifier.sent.length, 0); // handoff waits for the end of the call
  const t = [{ role: "assistant", content: "Good morning, Aangan Studio — how can I help you today?" }, { role: "user", content: "We have a 3BHK in Kothrud and want to redo the whole flat" }, { role: "assistant", content: "Lovely." }];
  const r = await (await hook(handle, { id: "evt_a", type: "call.completed", created: 1790000000, data: { call_id: "v1", duration_sec: 180, transcript: t } })).json() as any;
  assert.equal(r.verdict, "qualified");
  const rec = (await repo.getByProviderCallId("v1"))!;
  assert.equal(rec.bookingStatus, "booked"); assert.equal(rec.handoffStatus, "sent"); assert.equal(rec.crmStatus, "created");
  assert.deepEqual(rec.auditIssues, []);
  assert.equal(notifier.sent.length, 1); assert.ok(notifier.sent[0].text.includes("Consultation booked: YES")); assert.equal(crm.deals.length, 1);
  assert.equal(repo.costs.filter((c) => c.service === "calcom").length, 2); // availability + book, counted once each
});

test("booking failure through the tool: the AI is told not to claim it", async () => {
  const { handle, calendar, repo } = build();
  await post(handle, "/tools/qualify", { callId: "v2", serviceType: "full_home" });
  calendar.failNext = true;
  const bk = await (await post(handle, "/tools/book", { callId: "v2", slotStart: "2026-10-09T05:30:00Z" })).json() as any;
  assert.equal(bk.confirmed, false); assert.ok(bk.say.includes("Do not say it is booked"));
  assert.equal((await repo.getByProviderCallId("v2"))!.bookingStatus, "failed");
});

test("after-call audit: a quoted price raises a senior alert, is stored, and shows as needing attention", async () => {
  const { handle, repo, notifier } = build();
  const t = [{ role: "agent", content: "Good morning, Aangan Studio — how can I help you today?" }, { role: "caller", content: "How much for a 2BHK full redesign in Baner?" }, { role: "agent", content: "Usually around 12 lakh." }];
  await hook(handle, { id: "evt_p", type: "call.completed", created: 1790000000, data: { call_id: "bad1", duration_sec: 60, transcript: t } });
  const rec = (await repo.getByProviderCallId("bad1"))!;
  assert.ok(rec.auditIssues!.includes("price_quoted") && rec.auditIssues!.includes("pricing_line_not_verbatim"));
  assert.ok(notifier.sent.some((m) => m.channel === "senior" && m.text.includes("SCRIPT BREACH")));
  assert.equal(needsAttention(rec), true);
  const s = summarise([rec], [], [{ service: "n", monthlyInr: 0, activeFrom: "2020-01-01", activeTo: null }], { from: "2026-01-01T00:00:00Z", to: "2027-01-01T00:00:00Z" });
  assert.equal(s.compliance.audited, 1); assert.equal(s.compliance.clean, 0);
});

test("booked on a call the rules say to decline is flagged", async () => {
  const { handle, repo } = build(fx("T03")); // Nashik: declined
  await post(handle, "/tools/qualify", { callId: "mm", serviceType: "full_home" });
  await post(handle, "/tools/book", { callId: "mm", slotStart: "2026-10-09T05:30:00Z" });
  const t = [{ role: "caller", content: "I'm in Nashik, redo my home" }, { role: "agent", content: DECLINE_SCRIPT }];
  await hook(handle, { id: "evt_m", type: "call.completed", created: 1790000000, data: { call_id: "mm", duration_sec: 40, transcript: t } });
  assert.ok((await repo.getByProviderCallId("mm"))!.auditIssues!.includes("booked_despite_verdict"));
});

test("a call the tools opened is matched to the completed webhook by time when the call id was not passed", async () => {
  const { handle, repo } = build();
  await post(handle, "/tools/qualify", { callerPhone: "+91990", serviceType: "full_home", intent: "full_execution", location: "Baner", timelineKind: "flexible", decisionMaker: "self" }); // no callId
  assert.equal(repo.calls.size, 1);
  const created = Math.floor(NOW.getTime() / 1000) + 120;
  await hook(handle, { id: "evt_t", type: "call.completed", created, data: { call_id: "platform-77", duration_sec: 150 } });
  assert.equal(repo.calls.size, 1); // attached, not duplicated
  const rec = [...repo.calls.values()][0];
  assert.equal(rec.providerCallId, "platform-77"); assert.equal(rec.verdict, "qualified");
});

test("webhook without a transcript falls back to what the tools recorded", async () => {
  const { handle, repo } = build();
  await post(handle, "/tools/qualify", { callId: "nt", serviceType: "restaurant" });
  await hook(handle, { id: "evt_n", type: "call.completed", created: 1790000000, data: { call_id: "nt", duration_sec: 30 } });
  const rec = (await repo.getByProviderCallId("nt"))!;
  assert.equal(rec.verdict, "declined"); assert.equal(rec.auditIssues, null); // not audited: nothing to audit
});

test("one desk tool: action picks qualify, availability or book; unknown action is a clear error", async () => {
  const { handle, calendar } = build();
  const q = await (await post(handle, "/tools/desk", { action: "qualify", callId: "d1", serviceType: "restaurant" })).json() as any;
  assert.equal(q.verdict, "declined"); assert.equal(q.say, DECLINE_SCRIPT);
  const q2 = await (await post(handle, "/tools/desk", { action: "qualify", callId: "d2", serviceType: "full_home", intent: "full_execution", location: "Baner", timelineKind: "flexible", decisionMaker: "self", alreadyAsked: "project, location" })).json() as any;
  assert.equal(q2.verdict, "qualified");
  const av = await (await post(handle, "/tools/desk", { action: "availability", callId: "d2" })).json() as any;
  assert.equal(av.slots.length, 2);
  const bk = await (await post(handle, "/tools/desk", { action: "book", callId: "d2", slotStart: av.slots[0].start })).json() as any;
  assert.equal(bk.confirmed, true); assert.equal(calendar.booked.length, 1);
  const bad = await (await post(handle, "/tools/desk", { action: "dance" })).json() as any;
  assert.equal(bad.error, true);
});

// ---- the real app.vaanivoice.ai webhook: {event, call_id, timestamp, data} ----------------

function nativeHandler(details: (id: string) => { status: number; body?: object } | "throw", apiKey: string | null = "vk") {
  const seen: { url: string; key: string | null }[] = [];
  const fetchImpl = (async (url: string, init: RequestInit = {}) => {
    seen.push({ url, key: (init.headers as Record<string, string>)?.["X-API-Key"] ?? null });
    const r = details(decodeURIComponent(url.split("/").pop()!));
    if (r === "throw") throw new Error("network");
    return new Response(JSON.stringify(r.body ?? {}), { status: r.status });
  }) as unknown as typeof fetch;
  const b = build();
  const handle = createHandler(b.deps, { brainSecret: SECRET, vaaniWebhookSecret: "", vaaniApiKey: apiKey ?? undefined, fetchImpl });
  return { ...b, handle, seen };
}
const nativePost = (h: (r: Request) => Promise<Response>, body: object) =>
  h(new Request("http://x/webhooks/vaani", { method: "POST", body: JSON.stringify(body) }));
const TRANSCRIPT = "[2026-10-08 10:00:01] AGENT: Good morning, Aangan Studio — how can I help you today?\n[2026-10-08 10:00:08] USER: I have a 3BHK in Kothrud and want to redo the whole flat\nand I am the owner\n[2026-10-08 10:00:15] AGENT: Lovely.";
const post_event = { event: "call_postprocessing", call_id: "inbound-1-abc", timestamp: "2026-10-08T10:05:00+00:00", data: { call_duration: 180000, summary: "x", transcript: "[ts] AGENT: ignored, the API copy is used" } };

test("native Vaani transcript strings parse, including wrapped lines and timestamps", () => {
  const t = parseTranscript({ transcript: TRANSCRIPT })!;
  assert.deepEqual(t.map((x) => x.speaker), ["agent", "caller", "agent"]);
  assert.ok(t[1].text.endsWith("owner")); assert.ok(t[1].text.includes("whole flat and I am"));
});

test("native webhook: a call Vaani confirms is processed from Vaani's own transcript, once", async () => {
  const { handle, repo, notifier, seen } = nativeHandler(() => ({ status: 200, body: { transcription: TRANSCRIPT } }));
  const r = await (await nativePost(handle, post_event)).json() as any;
  assert.equal(r.handled, true); assert.equal(r.transcript, true);
  assert.equal(seen[0].key, "vk"); assert.ok(seen[0].url.endsWith("/api/call_details/inbound-1-abc"));
  const rec = (await repo.getByProviderCallId("inbound-1-abc"))!;
  assert.equal(rec.verdict, "qualified"); assert.equal(rec.durationSec, 180); // milliseconds -> seconds
  assert.ok(rec.transcript.some((x) => x.text.includes("Kothrud")) && !rec.transcript.some((x) => x.text.includes("ignored")));
  assert.equal(notifier.sent.length, 1);
  const again = await (await nativePost(handle, post_event)).json() as any;
  assert.equal(again.duplicate, true); assert.equal(notifier.sent.length, 1); // retries do nothing
});

test("native webhook: a forged call id is rejected, nothing is created or sent", async () => {
  const { handle, repo, notifier } = nativeHandler(() => ({ status: 404, body: { message: "Call not found" } }));
  const res = await nativePost(handle, { ...post_event, call_id: "forged-99" });
  assert.equal(res.status, 404); assert.equal(repo.calls.size, 0); assert.equal(notifier.sent.length, 0);
});

test("native webhook: cannot verify without an API key, or when Vaani is unreachable (Vaani can retry)", async () => {
  assert.equal((await nativePost(nativeHandler(() => ({ status: 200 }), null).handle, post_event)).status, 503);
  const down = nativeHandler(() => "throw");
  assert.equal((await nativePost(down.handle, post_event)).status, 502); assert.equal(down.repo.calls.size, 0);
  const boom = nativeHandler(() => ({ status: 500 }));
  assert.equal((await nativePost(boom.handle, post_event)).status, 502);
});

test("native webhook: other events are ignored; missing call_id is a 400; placeholder transcript falls back to the payload", async () => {
  const { handle, repo } = nativeHandler(() => ({ status: 200, body: { transcription: "Transcript is not available for further evaluations." } }));
  assert.equal(((await (await nativePost(handle, { event: "call_ended", room_name: "r", call_duration: 42 })).json()) as any).handled, false);
  assert.equal((await nativePost(handle, { event: "call_postprocessing" })).status, 400);
  const r = await (await nativePost(handle, { ...post_event, data: { ...post_event.data, transcript: TRANSCRIPT } })).json() as any;
  assert.equal(r.transcript, true); assert.equal((await repo.getByProviderCallId("inbound-1-abc"))!.verdict, "qualified");
});

test("native webhook: matches the call the desk tool opened, by time, since Vaani's call id is unknown to the tool", async () => {
  const { handle, repo } = nativeHandler(() => ({ status: 200, body: { transcription: TRANSCRIPT } }));
  await post(handle, "/tools/desk", { action: "qualify", callerPhone: "+91990", serviceType: "full_home", intent: "full_execution", location: "Kothrud", timelineKind: "flexible", decisionMaker: "self" });
  const ts = new Date(NOW.getTime() + 3 * 60000).toISOString();
  await nativePost(handle, { ...post_event, timestamp: ts, data: { ...post_event.data, call_duration: 150000 } });
  assert.equal(repo.calls.size, 1); assert.equal([...repo.calls.values()][0].providerCallId, "inbound-1-abc");
});

test("after the call, a qualified caller is auto-booked provisionally and the designer is told to confirm", async () => {
  const { handle, notifier, repo, calendar } = nativeHandler(() => ({ status: 200, body: { transcription: TRANSCRIPT } }));
  await nativePost(handle, post_event);
  const rec = (await repo.getByProviderCallId("inbound-1-abc"))!;
  assert.equal(rec.bookingStatus, "provisional"); assert.ok(rec.bookingRef); assert.ok(rec.bookingTime);
  assert.equal(calendar.booked.length, 1); assert.ok(calendar.booked[0].notes.includes("PROVISIONALLY BOOKED"));
  assert.ok(notifier.sent[0].text.includes("PROVISIONALLY BOOKED") && notifier.sent[0].text.includes("phone them to confirm"));
  assert.ok(notifier.sent[0].text.includes("Free slots to offer the caller:")); // alternatives if the first does not suit
  assert.equal(repo.costs.filter((c) => c.service === "calcom").length, 2); // slots lookup + booking
  const s = summarise([rec], [], [{ service: "n", monthlyInr: 0, activeFrom: "2020-01-01", activeTo: null }], { from: "2020-01-01T00:00:00Z", to: "2030-01-01T00:00:00Z" });
  assert.equal(s.consultationsBooked, 1); assert.equal(s.consultationsProvisional, 1);
});

test("auto-booking falls back to listing slots when the calendar refuses, and can be switched off", async () => {
  const a = nativeHandler(() => ({ status: 200, body: { transcription: TRANSCRIPT } }));
  a.calendar.failNext = true;
  await nativePost(a.handle, post_event);
  const rec = (await a.repo.getByProviderCallId("inbound-1-abc"))!;
  assert.notEqual(rec.bookingStatus, "provisional"); assert.equal(rec.handoffStatus, "sent");
  assert.ok(a.notifier.sent[0].text.includes("Free slots to offer the caller:") && !a.notifier.sent[0].text.includes("PROVISIONALLY"));

  const b = nativeHandler(() => ({ status: 200, body: { transcription: TRANSCRIPT } }));
  b.deps.autoBook = false;
  await nativePost(b.handle, post_event);
  assert.equal(b.calendar.booked.length, 0); assert.ok(b.notifier.sent[0].text.includes("Free slots to offer the caller:"));
});

test("declined, deferred and already-booked calls are never auto-booked", async () => {
  const decl = nativeHandler(() => ({ status: 200, body: { transcription: "AGENT: Hello\nUSER: I want a restaurant designed" } }));
  const d2 = build(fx("T19")); // restaurant
  const h = createHandler(d2.deps, { brainSecret: SECRET, vaaniWebhookSecret: "", vaaniApiKey: "k", fetchImpl: (async () => new Response(JSON.stringify({ transcription: "AGENT: Hello\nUSER: I want a restaurant designed" }), { status: 200 })) as unknown as typeof fetch });
  await nativePost(h, { ...post_event, call_id: "decl-1" });
  assert.equal(d2.calendar.booked.length, 0); assert.equal((await d2.repo.getByProviderCallId("decl-1"))!.verdict, "declined");
  void decl;
  // booked in the call via the tool: not booked a second time
  const t = nativeHandler(() => ({ status: 200, body: { transcription: TRANSCRIPT } }));
  const av = await (await post(t.handle, "/tools/desk", { action: "availability", callId: "inbound-1-abc" })).json() as any;
  await post(t.handle, "/tools/desk", { action: "qualify", callId: "inbound-1-abc", serviceType: "full_home", intent: "full_execution", location: "Kothrud", timelineKind: "flexible", decisionMaker: "self" });
  await post(t.handle, "/tools/desk", { action: "book", callId: "inbound-1-abc", slotStart: av.slots[0].start });
  await nativePost(t.handle, post_event);
  assert.equal(t.calendar.booked.length, 1); assert.equal((await t.repo.getByProviderCallId("inbound-1-abc"))!.bookingStatus, "booked");
});

test("audit treats expanded contractions as the same words (you'd = you would)", () => {
  const t = turns(["caller", "how much?"], ["agent", PRICING_DEFLECTION.replace("you'd", "you would")]);
  assert.deepEqual(auditAgentTurns(t, { verdict: "qualified" }), []);
  const tampered = turns(["caller", "how much?"], ["agent", PRICING_DEFLECTION.replace("site,", "site and")]);
  assert.deepEqual(auditAgentTurns(tampered, { verdict: "qualified" }), ["pricing_line_not_verbatim"]);
});
