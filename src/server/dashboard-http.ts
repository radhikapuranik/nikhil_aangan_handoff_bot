import { timingSafeEqual } from "node:crypto";
import { buildDashboard } from "../db/dashboard.ts";
import type { CallRepository } from "../db/repository.ts";

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });

const DAY = 86400000;
const isoDay = /^\d{4}-\d{2}-\d{2}$/;

// GET /api/dashboard?from=YYYY-MM-DD&to=YYYY-MM-DD   (both inclusive, IST days)
// The page holds caller data, so every request needs the dashboard password.
export function createDashboardHandler(repo: CallRepository, cfg: { password: string; demo: boolean; now?: () => Date }) {
  return async function handle(req: Request): Promise<Response> {
    if (req.method !== "GET") return json(405, { error: "method not allowed" });
    const a = Buffer.from(req.headers.get("authorization") ?? ""), b = Buffer.from(`Bearer ${cfg.password}`);
    if (!cfg.password || a.length !== b.length || !timingSafeEqual(a, b)) return json(401, { error: "unauthorised" });

    const url = new URL(req.url);
    const now = (cfg.now ?? (() => new Date()))();
    const toDay = url.searchParams.get("to") ?? new Date(now.getTime() + 330 * 60000).toISOString().slice(0, 10);
    const fromDay = url.searchParams.get("from") ?? new Date(now.getTime() + 330 * 60000 - 29 * DAY).toISOString().slice(0, 10);
    if (!isoDay.test(fromDay) || !isoDay.test(toDay)) return json(400, { error: "from and to must be YYYY-MM-DD" });

    // IST midnight to IST midnight, so "today" means the studio's today.
    const from = new Date(Date.parse(fromDay + "T00:00:00Z") - 330 * 60000);
    const to = new Date(Date.parse(toDay + "T00:00:00Z") + DAY - 330 * 60000);
    if (!(from < to)) return json(400, { error: "from must not be after to" });
    if (to.getTime() - from.getTime() > 400 * DAY) return json(400, { error: "range too long (max 400 days)" });

    try {
      return json(200, { demo: cfg.demo, ...(await buildDashboard(repo, { from: from.toISOString(), to: to.toISOString() })) });
    } catch (e) {
      console.error("dashboard failed", e);
      return json(500, { error: "could not load data" });
    }
  };
}
