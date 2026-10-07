import { createRepository } from "../db/index.ts";
import { MemoryRepository } from "../db/memory.ts";
import { seedDemo } from "../fixtures/seed.ts";
import { createIntegrations } from "../integrations/index.ts";
import type { SessionDeps } from "../session/call-session.ts";
import { createDashboardHandler } from "./dashboard-http.ts";
import { createHandler } from "../voice/http.ts";

type Env = Record<string, string | undefined>;
const cache = new Map<string, unknown>();
const once = <T>(k: string, f: () => T): T => (cache.has(k) ? (cache.get(k) as T) : (cache.set(k, f()), cache.get(k) as T));

export const hasDatabase = (env: Env) => Boolean(env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY);

// One shared set of dependencies per server instance.
export function brainHandler(env: Env = process.env) {
  return once("brain", () => {
    const integ = createIntegrations(env);
    const deps: SessionDeps = { ...integ, repo: createRepository(env) };
    return createHandler(deps, { brainSecret: env.BRAIN_SHARED_SECRET ?? "", vaaniWebhookSecret: env.VAANI_WEBHOOK_SECRET ?? "" });
  });
}

export async function dashboardHandler(env: Env = process.env) {
  const demo = env.DEMO_MODE === "1";
  if (!hasDatabase(env) && !demo) {
    // Refuse rather than show an empty dashboard that looks like "no calls".
    return async () => new Response(JSON.stringify({ error: "Supabase is not configured. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY, or DEMO_MODE=1 for sample data." }), { status: 503, headers: { "Content-Type": "application/json" } });
  }
  const repo = hasDatabase(env) ? createRepository(env) : once("demo-repo", () => new MemoryRepository());
  if (!hasDatabase(env) && !cache.has("seeded")) { cache.set("seeded", true); await seedDemo(repo); }
  return createDashboardHandler(repo, { password: env.DASHBOARD_PASSWORD ?? "", demo: !hasDatabase(env) });
}
