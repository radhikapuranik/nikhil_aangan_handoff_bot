import { geminiCost, vaaniCost, calcomCost, telegramCost, hubspotCost } from "../core/costs.ts";
import { evaluate } from "../core/qualify.ts";
import { finishCall, startCall } from "../db/recorder.ts";
import type { CallRepository } from "../db/repository.ts";
import { PHONE_FIXTURES } from "./phone-transcripts.ts";

// DEMO DATA ONLY. Replays the T01-T20 facts as if they were calls spread over
// recent days, with made-up timings, so the dashboard has something to show
// before real calls exist. Never written to a real database unless asked.

function rng(seed: number) { let s = seed; return () => (s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296; }

export async function seedDemo(repo: CallRepository, opts: { days?: number; calls?: number; now?: Date } = {}) {
  const days = opts.days ?? 30, n = opts.calls ?? 70, now = opts.now ?? new Date();
  const r = rng(42);
  // Fees nobody has confirmed yet. Null means unknown, so the dashboard flags the total as incomplete.
  await repo.addFixedCost({ service: "Phone number rental + telephony", monthlyInr: null, activeFrom: "2020-01-01", activeTo: null });
  const usable = PHONE_FIXTURES.filter((f) => f.facts);
  for (let i = 0; i < n; i++) {
    const fx = usable[Math.floor(r() * usable.length)];
    // About a third of enquiries arrive outside 10:00-19:00 IST, as in the brief.
    const after = r() < 0.33;
    const dayOffset = Math.floor(r() * days);
    const istMinutes = after ? (r() < 0.5 ? Math.floor(r() * 9 * 60) : 19 * 60 + Math.floor(r() * 5 * 60)) : 10 * 60 + Math.floor(r() * 9 * 60);
    const day = new Date(now.getTime() - dayOffset * 86400000);
    const startedAt = new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), 0, 0) + (istMinutes - 330) * 60000).toISOString();
    // Stay inside [now - days, now]: a time-of-day offset must not push a call outside the window.
    if (new Date(startedAt) > now || new Date(startedAt).getTime() < now.getTime() - days * 86400000) { i--; continue; }
    const duration = 90 + Math.floor(r() * 300);
    const rec = await startCall(repo, { providerCallId: `demo-${i}`, startedAt, answerLatencyMs: 600 + Math.floor(r() * 1400), callerPhone: `+9198${String(10000000 + Math.floor(r() * 89999999))}` });
    const decision = evaluate(fx.facts!, { c1: 1, c3: 2, c5: 1, c2: 2 }, new Date(startedAt));
    const qualified = decision.verdict === "qualified";
    const booked = qualified && r() < 0.75;
    const handoffFailed = qualified && r() < 0.04;
    const costs = [vaaniCost(duration), ...geminiCost(2500 + Math.floor(r() * 2500), 300 + Math.floor(r() * 300))];
    if (qualified) costs.push(telegramCost(), hubspotCost(), calcomCost());
    await finishCall(repo, rec.id, {
      decision, facts: { ...fx.facts!, callerName: fx.facts!.callerName ?? null }, transcript: [],
      endedAt: new Date(new Date(startedAt).getTime() + duration * 1000).toISOString(), durationSec: duration,
      pricingAsked: !!fx.pricingQuestions,
      auditIssues: r() < 0.04 ? ["price_quoted", "pricing_line_not_verbatim"] : [],
      booking: qualified ? { status: booked ? "booked" : "declined_by_caller", time: booked ? new Date(new Date(startedAt).getTime() + 3 * 86400000).toISOString() : undefined } : undefined,
      handoff: qualified ? { status: handoffFailed ? "failed" : "sent" } : undefined,
      crm: qualified ? { status: "created", dealId: `demo-deal-${i}` } : undefined,
      costs,
    });
  }
}
