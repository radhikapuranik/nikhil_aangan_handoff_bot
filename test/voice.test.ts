import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { MemoryRepository } from "../src/db/memory.ts";
import { MockCalendar, MockCrm, MockLlm, MockNotifier } from "../src/integrations/mock.ts";
import type { LlmService } from "../src/integrations/types.ts";
import type { CallFacts } from "../src/core/types.ts";
import type { SessionDeps } from "../src/session/call-session.ts";
import { createHandler, DEGRADED_SAY } from "../src/voice/http.ts";
import { parseCallEvent, verifySignature } from "../src/voice/vaani-webhook.ts";
import { PHONE_FIXTURES } from "../src/fixtures/phone-transcripts.ts";
import { PRICING_DEFLECTION } from "../src/core/scripts.ts";

const t01 = PHONE_FIXTURES.find((f) => f.id === "T01")!.facts as CallFacts;
const NOW = new Date("2026-10-07T05:00:00Z");
const BRAIN = "brain-secret", WH = "vv_whk_test";

function build(over: Partial<LlmService> = {}) {
  const mock = new MockLlm();
  const llm: LlmService = {
    triage: (u) => mock.triage(u), chooseSlot: (u, s) => mock.chooseSlot(u, s),
    extractFacts: async () => ({ facts: t01, usage: { inputTokens: 100, outputTokens: 10 } }), ...over,
  };
  const repo = new MemoryRepository(), notifier = new MockNotifier(), crm = new MockCrm(), calendar = new MockCalendar();
  const deps: SessionDeps = { repo, llm, notifier, crm, calendar, now: () => NOW };
  return { repo, notifier, crm, calendar, deps, handle: createHandler(deps, { brainSecret: BRAIN, vaaniWebhookSecret: WH }) };
}
const call = (handle: (r: Request) => Promise<Response>, path: string, body: object, auth: string | null = BRAIN) =>
  handle(new Request(`http://x${path}`, { method: "POST", headers: { "content-type": "application/json", ...(auth ? { authorization: `Bearer ${auth}` } : {}) }, body: JSON.stringify(body) }));
const sign = (raw: string, secret = WH) => "sha256=" + createHmac("sha256", secret).update(raw).digest("hex");
const hook = (handle: (r: Request) => Promise<Response>, env: object, sig?: string) => {
  const raw = JSON.stringify(env);
  return handle(new Request("http://x/webhooks/vaani", { method: "POST", headers: { "x-vaanivoice-signature": sig ?? sign(raw) }, body: raw }));
};

test("brain endpoints require the shared secret", async () => {
  const { handle } = build();
  assert.equal((await call(handle, "/call/start", { providerCallId: "p" }, null)).status, 401);
  assert.equal((await call(handle, "/call/start", { providerCallId: "p" }, "wrong")).status, 401);
  assert.equal((await call(handle, "/call/start", { providerCallId: "p" })).status, 200);
  assert.equal((await call(handle, "/call/start", {})).status, 400);
});

test("a full call over HTTP, resumed from the database on every turn", async () => {
  const { handle, repo, notifier } = build();
  const s = await (await call(handle, "/call/start", { providerCallId: "p1", callerPhone: "+919800000001", answerLatencyMs: 700 })).json() as any;
  assert.ok(s.say.startsWith("Good morning, Aangan Studio"));
  const t1 = await (await call(handle, "/call/turn", { providerCallId: "p1", utterance: "full redesign in Kothrud" })).json() as any;
  assert.ok(t1.say.includes("book your consultation"));
  // a brand-new handler (another server instance) shares only the database
  const other = createHandler({ ...build().deps, repo }, { brainSecret: BRAIN, vaaniWebhookSecret: WH });
  const t2 = await (await call(other, "/call/turn", { providerCallId: "p1", utterance: "the first one" })).json() as any;
  assert.ok(t2.say.startsWith("You're booked")); assert.equal(t2.end, true);
  const e = await (await call(other, "/call/end", { providerCallId: "p1", durationSec: 200 })).json() as any;
  assert.equal(e.verdict, "qualified"); assert.equal(e.bookingStatus, "booked"); assert.equal(e.handoffStatus, "sent");
  const rec = (await repo.getByProviderCallId("p1"))!;
  assert.equal(rec.answerLatencyMs, 700); assert.equal(rec.transcript.length, 5);
  assert.equal(notifier.sent.length, 0); // handoff went through the build()'s own notifier, not this one
});

test("ending a call twice does not send a second handoff or deal", async () => {
  const { handle, notifier, crm } = build();
  await call(handle, "/call/start", { providerCallId: "p2" });
  await call(handle, "/call/turn", { providerCallId: "p2", utterance: "full redesign in Kothrud" });
  await call(handle, "/call/end", { providerCallId: "p2", durationSec: 100 });
  await call(handle, "/call/end", { providerCallId: "p2", durationSec: 100 });
  assert.equal(notifier.sent.length, 1); assert.equal(crm.deals.length, 1);
});

test("turn after the call has ended just returns end", async () => {
  const { handle } = build();
  await call(handle, "/call/start", { providerCallId: "p3" });
  await call(handle, "/call/end", { providerCallId: "p3", durationSec: 5 });
  const r = await (await call(handle, "/call/turn", { providerCallId: "p3", utterance: "hello?" })).json() as any;
  assert.equal(r.end, true); assert.equal(r.say, "");
});

test("unknown call id is a 404, not a crash", async () => {
  const { handle } = build();
  assert.equal((await call(handle, "/call/turn", { providerCallId: "nope", utterance: "hi" })).status, 404);
});

test("if the model fails mid-call the caller hears a safe line, and the webhook later closes the call", async () => {
  const { handle, repo } = build({ extractFacts: async () => { throw new Error("gemini down"); } });
  await call(handle, "/call/start", { providerCallId: "p4" });
  const r = await (await call(handle, "/call/turn", { providerCallId: "p4", utterance: "hello" })).json() as any;
  assert.equal(r.say, DEGRADED_SAY); assert.equal(r.end, true); assert.equal(r.degraded, true);
  const res = await hook(handle, { id: "evt_1", type: "call.completed", created: 1790000000, data: { call_id: "p4", duration_sec: 30 } });
  assert.equal(res.status, 200);
  const rec = (await repo.getByProviderCallId("p4"))!;
  assert.equal(rec.verdict, "abandoned"); assert.equal(rec.durationSec, 30);
});

test("pricing line stays verbatim through the HTTP layer", async () => {
  const noDm = { ...t01, decisionMaker: "unknown" as const };
  const { handle } = build({ extractFacts: async () => ({ facts: noDm, usage: { inputTokens: 1, outputTokens: 1 } }) });
  await call(handle, "/call/start", { providerCallId: "p5" });
  const r = await (await call(handle, "/call/turn", { providerCallId: "p5", utterance: "even a rough range please" })).json() as any;
  assert.equal(r.say, PRICING_DEFLECTION);
});

test("webhook: signature is checked over the raw body", async () => {
  const { handle } = build();
  const env = { id: "evt_a", type: "webhook.ping", created: 1, data: {} };
  assert.equal((await hook(handle, env, "sha256=deadbeef")).status, 401);
  assert.equal((await hook(handle, env, sign(JSON.stringify(env), "wrong-secret"))).status, 401);
  assert.equal((await hook(handle, env)).status, 200);
  assert.equal(verifySignature("body", null, WH), false);
  assert.equal(verifySignature("body", "md5=abc", WH), false);
  assert.equal(verifySignature("body", sign("body"), WH), true);
  // A forged event signed with an empty key must fail when no secret is configured.
  const forged = "sha256=" + createHmac("sha256", "").update("body").digest("hex");
  assert.equal(verifySignature("body", forged, ""), false);
});

test("webhook: Vaani retries (same evt id) are applied once", async () => {
  const { handle, repo } = build();
  const env = { id: "evt_dup", type: "call.completed", created: 1790000000, data: { call_id: "ghost", duration_sec: 60 } };
  const a = await (await hook(handle, env)).json() as any, b = await (await hook(handle, env)).json() as any;
  assert.equal(a.handled, true); assert.equal(b.duplicate, true);
  assert.equal(repo.calls.size, 1);
});

test("webhook: a call that never reached the brain is still logged, with its cost", async () => {
  const { handle, repo } = build();
  await hook(handle, { id: "evt_u", type: "call.completed", created: 1790000000, data: { call_id: "unseen-1", duration_sec: 120 } });
  const rec = (await repo.getByProviderCallId("unseen-1"))!;
  assert.equal(rec.verdict, "abandoned"); assert.ok(rec.reasons[0].includes("no transcript and no tool activity"));
  assert.equal(repo.costs.find((c) => c.service === "vaani")!.costInr, 11.16); // 2 min x Rs 5.58
});

test("webhook: call.completed finishes an in-progress call and sends its handoff", async () => {
  const { handle, repo, notifier } = build();
  await call(handle, "/call/start", { providerCallId: "p6" });
  await call(handle, "/call/turn", { providerCallId: "p6", utterance: "full redesign in Kothrud" }); // slots offered, caller hangs up
  const r = await (await hook(handle, { id: "evt_f", type: "call.completed", created: 1790000000, data: { call_id: "p6", duration_ms: 95000 } })).json() as any;
  assert.equal(r.verdict, "qualified");
  assert.equal((await repo.getByProviderCallId("p6"))!.durationSec, 95);
  assert.equal(notifier.sent.length, 1);
});

test("webhook: call.failed on an open call is recorded with the pipeline reason", async () => {
  const { handle, repo } = build();
  await call(handle, "/call/start", { providerCallId: "p7" });
  await hook(handle, { id: "evt_x", type: "call.failed", created: 1790000000, data: { call_id: "p7" } });
  const rec = (await repo.getByProviderCallId("p7"))!;
  assert.ok(rec.reasons.some((r) => r.includes("pipeline error")));
});

test("webhook: unknown event types and payloads without a call id are stored, not crashed on", async () => {
  const { handle, repo } = build();
  assert.equal((await hook(handle, { id: "evt_l", type: "lead.created", created: 1, data: { x: 1 } })).status, 200);
  const r = await (await hook(handle, { id: "evt_n", type: "call.completed", created: 1, data: "weird" })).json() as any;
  assert.equal(r.handled, false); assert.equal(repo.events.size, 2);
});

test("parseCallEvent reads alternative field names defensively", () => {
  assert.deepEqual(parseCallEvent({ callId: 55, duration: "61.4" }, 1_790_000_000).providerCallId, "55");
  assert.equal(parseCallEvent({ session_id: "s", durationMs: 2500 }, 1).durationSec, 3);
  assert.equal(parseCallEvent({}, 100).providerCallId, null);
  assert.equal(parseCallEvent({ started_at: 1_790_000_000 }, 1).startedAt, new Date(1_790_000_000_000).toISOString());
});
