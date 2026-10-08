import { timingSafeEqual } from "node:crypto";
import type { SessionDeps } from "../session/call-session.ts";
import { NotFound, endCallHandler, startCallHandler, turnHandler } from "./brain.ts";
import { availabilityTool, bookTool, qualifyTool } from "./tools.ts";
import { handleVaaniWebhook } from "./vaani-webhook.ts";

export interface HttpConfig { brainSecret: string; vaaniWebhookSecret: string; vaaniApiKey?: string; fetchImpl?: typeof fetch }

// NOT IN SPEC: what the caller hears if our server fails mid-call.
export const DEGRADED_SAY = "I'm sorry, I'm having trouble on my side. Someone from our team will call you back shortly. Thank you for calling Aangan Studio.";

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

function authorised(req: Request, secret: string) {
  const h = req.headers.get("authorization") ?? "";
  const a = Buffer.from(h), b = Buffer.from(`Bearer ${secret}`);
  return secret.length > 0 && a.length === b.length && timingSafeEqual(a, b);
}

const isStr = (v: unknown): v is string => typeof v === "string" && v.length > 0;

// Web-standard Request -> Response, so the same handler runs as a Vercel
// function or behind the local dev server.
export function createHandler(d: SessionDeps, cfg: HttpConfig) {
  return async function handle(req: Request): Promise<Response> {
    // On Vercel the functions live under /api/..., locally they are at the root.
    const path = new URL(req.url).pathname.replace(/^\/api(?=\/)/, "");
    try {
      if (req.method === "GET" && path === "/health") return json(200, { ok: true });
      if (req.method !== "POST") return json(405, { error: "method not allowed" });

      if (path === "/webhooks/vaani") {
        const raw = await req.text(); // signature covers the raw bytes
        const r = await handleVaaniWebhook(d, raw, req.headers.get("x-vaanivoice-signature"), cfg.vaaniWebhookSecret, { vaaniApiKey: cfg.vaaniApiKey, fetchImpl: cfg.fetchImpl });
        return json(r.status, r.body);
      }

      // One tool, three actions: Vaani's AI sends {action: "qualify" | "availability" | "book", ...}.
      const desk = (dd: SessionDeps, body: Record<string, unknown>) => {
        const a = String(body.action ?? "").toLowerCase();
        if (a === "qualify") return qualifyTool(dd, body);
        if (a === "availability" || a === "check_availability") return availabilityTool(dd, body);
        if (a === "book" || a === "book_consultation") return bookTool(dd, body);
        return Promise.resolve({ error: true, say: "Unknown action. Use action qualify, availability or book." });
      };
      const TOOLS = { "/tools/desk": desk, "/tools/qualify": qualifyTool, "/tools/availability": availabilityTool, "/tools/book": bookTool } as const;
      if (!["/call/start", "/call/turn", "/call/end", ...Object.keys(TOOLS)].includes(path)) return json(404, { error: "not found" });
      if (!authorised(req, cfg.brainSecret)) return json(401, { error: "unauthorised" });

      if (path in TOOLS) {
        let tb: Record<string, unknown>;
        try { tb = (await req.json()) as Record<string, unknown>; } catch { return json(400, { error: "invalid json" }); }
        try { return json(200, await TOOLS[path as keyof typeof TOOLS](d, tb ?? {})); }
        catch (e) {
          // The AI must always get something it can act on, never a bare error.
          console.error("tool failed", path, e);
          return json(200, { say: "That check did not work. Carry on with the rules you were given, and do not quote any price.", error: true });
        }
      }

      let b: Record<string, unknown>;
      try { b = (await req.json()) as Record<string, unknown>; } catch { return json(400, { error: "invalid json" }); }
      if (!isStr(b.providerCallId)) return json(400, { error: "providerCallId is required" });

      if (path === "/call/start")
        return json(200, await startCallHandler(d, {
          providerCallId: b.providerCallId,
          startedAt: isStr(b.startedAt) ? b.startedAt : undefined,
          answerLatencyMs: typeof b.answerLatencyMs === "number" ? b.answerLatencyMs : null,
          callerPhone: isStr(b.callerPhone) ? b.callerPhone : null,
        }));

      if (path === "/call/turn") {
        if (!isStr(b.utterance)) return json(400, { error: "utterance is required" });
        try {
          return json(200, await turnHandler(d, { providerCallId: b.providerCallId, utterance: b.utterance }));
        } catch (e) {
          if (e instanceof NotFound) throw e;
          // The caller must never hear silence or an error: speak a safe line and
          // end the call. The call stays open in the log; the end-of-call
          // webhook closes it and records what happened.
          console.error("turn failed", e);
          return json(200, { say: DEGRADED_SAY, end: true, degraded: true });
        }
      }

      if (typeof b.durationSec !== "number") return json(400, { error: "durationSec is required" });
      const rec = await endCallHandler(d, { providerCallId: b.providerCallId, endedAt: isStr(b.endedAt) ? b.endedAt : undefined, durationSec: b.durationSec });
      return json(200, { callId: rec.id, verdict: rec.verdict, handoffStatus: rec.handoffStatus, bookingStatus: rec.bookingStatus });
    } catch (e) {
      if (e instanceof NotFound) return json(404, { error: e.message });
      console.error("unhandled", e);
      return json(500, { error: "internal error" });
    }
  };
}
