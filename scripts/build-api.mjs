import { build } from "esbuild";
import { readdir, rm } from "node:fs/promises";
import { join, relative } from "node:path";

// Vercel does not bundle the shared code in src/ that each function imports,
// so every function in api-src/ is bundled into one self-contained file in
// api/. `pg` stays external (Vercel installs it from package.json).
async function* walk(dir) {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* walk(p); else if (e.name.endsWith(".ts")) yield p;
  }
}
await rm("api", { recursive: true, force: true });
const entries = [];
for await (const f of walk("api-src")) entries.push(f);
await build({
  entryPoints: entries, outdir: "api", outbase: "api-src", bundle: true, format: "esm", platform: "node", target: "node22",
  external: ["pg", "pg-native"], logLevel: "warning",
  banner: { js: 'import { createRequire as __cr } from "node:module"; const require = __cr(import.meta.url);' },
});
console.log("bundled", entries.map((f) => relative("api-src", f)).join(", "));
