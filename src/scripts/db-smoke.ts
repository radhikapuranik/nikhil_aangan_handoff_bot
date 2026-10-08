import pg from "pg";
import { vaaniCost, geminiCost } from "../core/costs.ts";
import { buildDashboard } from "../db/dashboard.ts";
import { PostgresRepository, typeParsers } from "../db/postgres.ts";
import { finishCall, startCall } from "../db/recorder.ts";

// Writes one clearly-labelled test call to the real database, reads it back
// through the dashboard query, and deletes it. Run: npm run db:smoke
const url = process.env.DATABASE_URL!;
const pool = new pg.Pool({ connectionString: url, max: 2, types: typeParsers });
const repo = new PostgresRepository(pool);
const pid = "smoke-" + Date.now();
const startedAt = new Date().toISOString();
try {
  const rec = await startCall(repo, { providerCallId: pid, startedAt, answerLatencyMs: 850, callerPhone: "+910000000000" });
  const again = await startCall(repo, { providerCallId: pid, startedAt, answerLatencyMs: 1 });
  console.log("retry returns same row:", again.id === rec.id);
  const done = await finishCall(repo, rec.id, {
    decision: { verdict: "declined", checks: null, reasons: ["smoke test"], flags: [], say: "x" },
    facts: null, transcript: [{ speaker: "agent", text: "hello", at: startedAt }], endedAt: startedAt, durationSec: 60,
    pricingAsked: false, costs: [vaaniCost(60), ...geminiCost(1000, 100)],
  });
  console.log("stored verdict:", done.verdict, "| transcript turns:", done.transcript.length, "| type of startedAt:", typeof done.startedAt);
  const d = await buildDashboard(repo, { from: new Date(Date.now() - 86400000).toISOString(), to: new Date(Date.now() + 86400000).toISOString() });
  const mine = d.recent.find((c) => c.id === rec.id);
  console.log("dashboard sees it:", Boolean(mine), "| cost:", mine?.costInr, "| masked phone:", mine?.phoneMasked);
  console.log("webhook event dedupe:", await repo.recordProviderEvent({ id: pid, type: "smoke", payload: {} }), await repo.recordProviderEvent({ id: pid, type: "smoke", payload: {} }));
} finally {
  await pool.query("delete from calls where provider_call_id = $1", [pid]);   // cascades to call_costs
  await pool.query("delete from provider_events where id = $1", [pid]);
  const left = await pool.query("select count(*)::int as n from calls where provider_call_id = $1", [pid]);
  console.log("cleaned up, leftover rows:", left.rows[0].n);
  await pool.end();
}
