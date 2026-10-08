import { createHmac } from "node:crypto";
import { readFile } from "node:fs/promises";
import { MemoryRepository } from "../db/memory.ts";
import { GeminiLlm, DEFAULT_GEMINI_MODEL } from "../integrations/gemini.ts";
import { MockCalendar, MockCrm, MockNotifier } from "../integrations/mock.ts";
import { createHandler } from "../voice/http.ts";
import { PHONE_FIXTURES } from "../fixtures/phone-transcripts.ts";

// Replays the real T01-T20 conversations as Vaani "call.completed" webhooks
// through the real after-call pipeline with LIVE Gemini and mock Telegram/CRM/calendar.
// Usage: npm run live:webhook
const key = process.env.GEMINI_API_KEY!;
const texts = JSON.parse(await readFile(new URL("../fixtures/phone-transcripts-text.json", import.meta.url), "utf8")) as { id: string; date: string; turns: { speaker: string; text: string }[] }[];
const repo = new MemoryRepository(), notifier = new MockNotifier(), crm = new MockCrm();

let agree = 0, n = 0;
for (const t of texts.filter((x) => x.turns.length)) {
  // "Today" for the model is the day of the call, as it would be live.
  const llm = new GeminiLlm(key, process.env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL, fetch, () => new Date(t.date + "T10:00:00Z"));
  const handle = createHandler({ repo, llm, notifier, crm, calendar: new MockCalendar() }, { brainSecret: "x", vaaniWebhookSecret: "s" });
  const fx = PHONE_FIXTURES.find((f) => f.id === t.id)!;
  const data = { call_id: t.id, duration_sec: 240, transcript: t.turns.map((x) => ({ role: x.speaker === "agent" ? "assistant" : "user", content: x.text })) };
  const raw = JSON.stringify({ id: "evt_" + t.id, type: "call.completed", created: Math.floor(new Date(t.date + "T10:00:00Z").getTime() / 1000), data });
  const res = await handle(new Request("http://x/webhooks/vaani", { method: "POST", headers: { "x-vaanivoice-signature": "sha256=" + createHmac("sha256", "s").update(raw).digest("hex") }, body: raw }));
  const body = (await res.json()) as { verdict?: string };
  const rec = [...repo.calls.values()].find((c) => c.providerCallId === t.id)!;
  const ok = body.verdict === fx.expected; n++; if (ok) agree++;
  console.log(`${t.id} ${ok ? "AGREE   " : "DISAGREE"} expected=${fx.expected.padEnd(9)} got=${String(body.verdict).padEnd(9)} handoff=${rec.handoffStatus.padEnd(18)} audit=${JSON.stringify(rec.auditIssues)}`);
}
console.log(`\n${agree}/${n} verdicts agree. Telegram messages that would be sent: ${notifier.sent.length} (${notifier.sent.filter((m) => m.text.includes("SCRIPT BREACH")).length} script-breach alerts, ${notifier.sent.filter((m) => m.channel === "senior").length} to the senior channel). CRM deals: ${crm.deals.length}.`);
