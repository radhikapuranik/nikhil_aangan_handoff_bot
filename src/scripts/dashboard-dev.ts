import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dashboardHandler } from "../server/bootstrap.ts";

// Local preview with SAMPLE data. Password: demo
process.env.DEMO_MODE ??= "1";
process.env.DASHBOARD_PASSWORD ??= "demo";
const handler = await dashboardHandler();
const port = Number(process.env.PORT ?? 8788);
createServer(async (nodeReq, nodeRes) => {
  const url = new URL(nodeReq.url ?? "/", `http://localhost:${port}`);
  if (url.pathname === "/api/dashboard") {
    const res = await handler(new Request(url, { headers: nodeReq.headers as Record<string, string> }));
    nodeRes.writeHead(res.status, Object.fromEntries(res.headers)); nodeRes.end(await res.text()); return;
  }
  nodeRes.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  nodeRes.end(await readFile(new URL("../../public/index.html", import.meta.url)));
}).listen(port, () => console.log(`dashboard preview (sample data) on http://localhost:${port}  password: demo`));
