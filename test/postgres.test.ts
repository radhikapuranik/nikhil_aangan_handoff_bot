import { test } from "node:test";
import assert from "node:assert/strict";
import { PostgresRepository, typeParsers, type Queryable } from "../src/db/postgres.ts";
import { createRepository, hasDatabase } from "../src/db/index.ts";
import { MemoryRepository } from "../src/db/memory.ts";

function fake(responses: ((sql: string, p: unknown[]) => Record<string, unknown>[])[]) {
  const calls: { sql: string; params: unknown[] }[] = [];
  let i = 0;
  const db: Queryable = { async query(sql, params = []) { calls.push({ sql, params }); return { rows: (responses[i++] ?? (() => []))(sql, params) }; } };
  return { db, calls };
}
const row = { id: "u1", provider_call_id: "p1", started_at: "2026-09-02T05:00:00.000Z", answer_latency_ms: 700, verdict: "in_progress", reasons: [], flags: [] };

test("createCall: jsonb columns are cast and serialised, snake_case columns", async () => {
  const { db, calls } = fake([() => [row]]);
  const rec = await new PostgresRepository(db).createCall({ providerCallId: "p1", startedAt: "2026-09-02T05:00:00Z", transcript: [{ speaker: "agent", text: "hi", at: "x" }] });
  assert.equal(rec.id, "u1"); assert.equal(rec.answerLatencyMs, 700);
  const { sql, params } = calls[0];
  assert.ok(sql.includes("on conflict (provider_call_id) do nothing"));
  assert.ok(sql.includes("provider_call_id") && sql.includes("started_at"));
  assert.match(sql, /\$\d+::jsonb/);
  assert.ok(params.includes(JSON.stringify([{ speaker: "agent", text: "hi", at: "x" }])));
});

test("createCall: a retried call returns the existing row and does not overwrite it", async () => {
  const { db, calls } = fake([() => [], () => [{ ...row, verdict: "qualified" }]]);
  const rec = await new PostgresRepository(db).createCall({ providerCallId: "p1", startedAt: "2026-09-02T05:00:00Z" });
  assert.equal(rec.verdict, "qualified");
  assert.ok(calls[1].sql.startsWith("select * from calls where provider_call_id"));
});

test("updateCall: skips undefined, casts jsonb, arrays pass through, missing row throws", async () => {
  const { db, calls } = fake([() => [{ ...row, verdict: "qualified" }]]);
  const repo = new PostgresRepository(db);
  const r = await repo.updateCall("u1", { verdict: "qualified", callerPhone: undefined, facts: { a: 1 } as never, reasons: ["x"], sessionState: { phase: "closed" } });
  assert.equal(r.verdict, "qualified");
  const { sql, params } = calls[0];
  assert.ok(!sql.includes("caller_phone")); assert.ok(sql.includes("facts = $") && sql.includes("::jsonb"));
  assert.ok(sql.includes("session_state = $"));
  assert.deepEqual(params[0], "u1"); assert.ok(params.some((p) => Array.isArray(p) && p[0] === "x"));
  await assert.rejects(new PostgresRepository(fake([() => []]).db).updateCall("nope", { verdict: "declined" }), /not found/);
});

test("costs, events and fixed fees use parameters (no string-built SQL)", async () => {
  const { db, calls } = fake([() => [], () => [{ id: "e1" }], () => []]);
  const repo = new PostgresRepository(db);
  await repo.addCosts("c1", [{ service: "vaani", units: 4, unit: "minute", costInr: null, rateNote: "n" }]);
  assert.deepEqual(calls[0].params, ["c1", "vaani", 4, "minute", null, "n"]);
  assert.equal(await repo.recordProviderEvent({ id: "evt_1", type: "call.completed", payload: { a: 1 } }), true);
  assert.ok(calls[1].sql.includes("on conflict (id) do nothing"));
  await repo.addFixedCost({ service: "number", monthlyInr: null, activeFrom: "2026-01-01", activeTo: null });
  assert.deepEqual(calls[2].params, ["number", null, "2026-01-01", null]);
  const dup = new PostgresRepository(fake([() => []]).db);
  assert.equal(await dup.recordProviderEvent({ id: "evt_1", type: "x", payload: {} }), false);
});

test("a hostile value never reaches SQL text", async () => {
  const { db, calls } = fake([() => [row]]);
  await new PostgresRepository(db).createCall({ startedAt: "2026-09-02T05:00:00Z", callerName: "x'); drop table calls;--" });
  assert.ok(!calls[0].sql.includes("drop table")); assert.ok(calls[0].params.includes("x'); drop table calls;--"));
});

test("type parsers: ISO timestamps, date strings, numbers", () => {
  assert.equal(typeParsers.getTypeParser(1184)("2026-09-02 10:30:00+05:30"), "2026-09-02T05:00:00.000Z");
  assert.equal(typeParsers.getTypeParser(1082)("2026-01-01"), "2026-01-01");
  assert.equal(typeParsers.getTypeParser(1700)("2.4000"), 2.4);
  assert.equal(typeParsers.getTypeParser(25)("text"), "text");
});

test("repository choice: DATABASE_URL wins, otherwise Supabase, otherwise memory", () => {
  assert.ok(createRepository({}) instanceof MemoryRepository);
  assert.equal(hasDatabase({}), false); assert.equal(hasDatabase({ DATABASE_URL: "x" }), true);
  assert.equal(hasDatabase({ SUPABASE_URL: "u", SUPABASE_SERVICE_ROLE_KEY: "k" }), true);
  assert.ok(createRepository({ DATABASE_URL: "postgresql://u:p@localhost:1/db" }).constructor.name === "PostgresRepository");
});
