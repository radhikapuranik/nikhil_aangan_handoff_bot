import { createInterface } from "node:readline/promises";
import { MemoryRepository } from "../db/memory.ts";
import { createIntegrations } from "../integrations/index.ts";
import { createHandler } from "../voice/http.ts";

// Talk to the agent in the terminal, through the same HTTP handler a voice
// platform would call. Uses mocks for anything without keys.
const integ = createIntegrations();
const repo = new MemoryRepository();
const handle = createHandler({ ...integ, repo }, { brainSecret: "sim", vaaniWebhookSecret: "sim" });
const post = async (path: string, body: object) =>
  (await handle(new Request(`http://x${path}`, { method: "POST", headers: { authorization: "Bearer sim", "content-type": "application/json" }, body: JSON.stringify(body) }))).json() as Promise<any>;

const id = "sim-" + Date.now();
console.log(`(mocked: ${integ.mocked.join(", ") || "none"}; the mock reader is crude, see README)\n`);
const start = await post("/call/start", { providerCallId: id, callerPhone: "+919800000000", answerLatencyMs: 800 });
console.log("AGENT:", start.say);
const rl = createInterface({ input: process.stdin });
const t0 = Date.now();
process.stdout.write("CALLER: ");
for await (const line of rl) {
  const u = line.trim();
  if (!u) break;
  if (!process.stdin.isTTY) console.log(u); // echo piped input so the transcript reads naturally
  const r = await post("/call/turn", { providerCallId: id, utterance: u });
  console.log("AGENT:", r.say);
  if (r.end) break;
  process.stdout.write("CALLER: ");
}
rl.close();
const end = await post("/call/end", { providerCallId: id, durationSec: Math.round((Date.now() - t0) / 1000) });
console.log("\nLOGGED:", end);
