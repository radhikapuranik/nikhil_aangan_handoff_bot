import { createServer } from "node:http";
import { createRepository } from "../db/index.ts";
import { createIntegrations } from "../integrations/index.ts";
import { createHandler } from "../voice/http.ts";

// Local dev server. In production the same handler runs as a Vercel function.
const env = process.env;
const integ = createIntegrations(env);
const handler = createHandler({ ...integ, repo: createRepository(env) }, {
  brainSecret: env.BRAIN_SHARED_SECRET ?? "dev-secret",
  vaaniWebhookSecret: env.VAANI_WEBHOOK_SECRET ?? "dev-webhook-secret",
});
const port = Number(env.PORT ?? 8787);
createServer(async (nodeReq, nodeRes) => {
  const chunks: Buffer[] = [];
  for await (const c of nodeReq) chunks.push(c as Buffer);
  const req = new Request(`http://localhost:${port}${nodeReq.url}`, {
    method: nodeReq.method, headers: nodeReq.headers as Record<string, string>,
    body: ["GET", "HEAD"].includes(nodeReq.method ?? "GET") ? undefined : Buffer.concat(chunks),
  });
  const res = await handler(req);
  nodeRes.writeHead(res.status, Object.fromEntries(res.headers));
  nodeRes.end(await res.text());
}).listen(port, () => console.log(`brain listening on :${port} (mocked: ${integ.mocked.join(", ") || "none"})`));
