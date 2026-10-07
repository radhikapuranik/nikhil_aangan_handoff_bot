import { createHmac, timingSafeEqual } from "node:crypto";
import { CallSession, type SessionDeps } from "../session/call-session.ts";
import { logUnseenCall } from "./brain.ts";

// Vaani webhooks: HMAC-SHA256 over the RAW body, sent as
// "X-VaaniVoice-Signature: sha256=<hex>" (vaanilabs.in/docs/samples/webhooks).
// Envelope: { id: "evt_...", type, created (unix s), data }.
// Vaani retries failed deliveries up to 8 times and says to de-duplicate on
// the envelope id. The docs say the data payload must be parsed defensively
// ("no sub-field is guaranteed"), so every field below is optional.

export function verifySignature(rawBody: string, header: string | null, secret: string): boolean {
  if (!header || !header.startsWith("sha256=")) return false;
  const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
  const got = header.slice("sha256=".length);
  const a = Buffer.from(expected, "utf8"), b = Buffer.from(got, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

const firstString = (o: Record<string, unknown>, keys: string[]): string | null => {
  for (const k of keys) { const v = o[k]; if (typeof v === "string" && v) return v; if (typeof v === "number") return String(v); }
  return null;
};
const firstNumber = (o: Record<string, unknown>, keys: string[]): number | null => {
  for (const k of keys) { const v = o[k]; if (typeof v === "number" && Number.isFinite(v)) return v; if (typeof v === "string" && v.trim() && Number.isFinite(Number(v))) return Number(v); }
  return null;
};

export function parseCallEvent(data: Record<string, unknown>, createdUnix: number) {
  const providerCallId = firstString(data, ["call_id", "callId", "session_id", "sessionId", "id"]);
  const ms = firstNumber(data, ["duration_ms", "durationMs"]);
  const durationSec = firstNumber(data, ["duration_sec", "duration_seconds", "durationSec", "duration"]) ?? (ms !== null ? ms / 1000 : null);
  const startedRaw = data.started_at ?? data.startedAt ?? data.start_time;
  let startedAt: string | null = null;
  if (typeof startedRaw === "string" && !Number.isNaN(Date.parse(startedRaw))) startedAt = new Date(startedRaw).toISOString();
  else if (typeof startedRaw === "number") startedAt = new Date(startedRaw > 1e12 ? startedRaw : startedRaw * 1000).toISOString();
  else if (durationSec !== null) startedAt = new Date((createdUnix - durationSec) * 1000).toISOString();
  else startedAt = new Date(createdUnix * 1000).toISOString();
  return { providerCallId, durationSec: durationSec !== null ? Math.round(durationSec) : null, startedAt };
}

export type WebhookResult = { status: number; body: Record<string, unknown> };

export async function handleVaaniWebhook(d: SessionDeps, rawBody: string, signature: string | null, secret: string): Promise<WebhookResult> {
  if (!verifySignature(rawBody, signature, secret)) return { status: 401, body: { error: "bad signature" } };

  let env: { id?: unknown; type?: unknown; created?: unknown; data?: unknown };
  try { env = JSON.parse(rawBody); } catch { return { status: 400, body: { error: "invalid json" } }; }
  if (typeof env.id !== "string" || typeof env.type !== "string") return { status: 400, body: { error: "not a Vaani envelope" } };

  const fresh = await d.repo.recordProviderEvent({ id: env.id, type: env.type, payload: env });
  if (!fresh) return { status: 200, body: { duplicate: true } }; // retry of something already handled

  if (env.type !== "call.completed" && env.type !== "call.failed") return { status: 200, body: { stored: true, handled: false } };

  const data = (env.data && typeof env.data === "object" ? env.data : {}) as Record<string, unknown>;
  const created = typeof env.created === "number" ? env.created : Math.floor(Date.now() / 1000);
  const ev = parseCallEvent(data, created);
  const failed = env.type === "call.failed";
  if (!ev.providerCallId) return { status: 200, body: { stored: true, handled: false, reason: "no call id in payload" } };

  const rec = await d.repo.getByProviderCallId(ev.providerCallId);
  if (!rec) {
    // The call never reached the brain. Log it anyway, so no call is silent.
    const logged = await logUnseenCall(d, {
      providerCallId: ev.providerCallId, startedAt: ev.startedAt!, durationSec: ev.durationSec ?? 0,
      reason: failed ? "voice platform reported a pipeline error and no turns reached the brain" : "call reached the voice platform but no turns reached the brain",
    });
    return { status: 200, body: { handled: true, loggedUnseen: true, callId: logged.id } };
  }

  const s = CallSession.resume(d, rec);
  const done = await s.finish({
    endedAt: new Date(created * 1000).toISOString(),
    durationSec: ev.durationSec ?? Math.max(0, Math.round((created * 1000 - new Date(rec.startedAt).getTime()) / 1000)),
  });
  if (failed && done.reasons.every((r) => !r.includes("pipeline"))) {
    await d.repo.updateCall(done.id, { reasons: [...done.reasons, "voice platform reported a pipeline error mid-call"] });
  }
  return { status: 200, body: { handled: true, callId: done.id, verdict: done.verdict } };
}
