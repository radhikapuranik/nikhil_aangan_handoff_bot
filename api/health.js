import { createRequire as __cr } from "node:module"; const require = __cr(import.meta.url);

// api-src/health.ts
var GET = () => new Response(JSON.stringify({ ok: true }), { headers: { "Content-Type": "application/json" } });
export {
  GET
};
