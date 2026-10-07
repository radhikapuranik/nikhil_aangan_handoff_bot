// Per-call cost model, in INR. Every rate here is an ASSUMPTION or unknown
// until confirmed against the real price pages. A null rate means "unknown":
// the ledger stores a null cost, and the dashboard reports the total as
// incomplete instead of counting it as zero.

export interface Rates {
  usdToInr: number;
  vaaniPerMinuteInr: number | null; // unknown until Vaani pricing is confirmed
  geminiInputPerMTokUsd: number;    // gemini-3.5-flash-lite, ai.google.dev/gemini-api/docs/pricing
  geminiOutputPerMTokUsd: number;
  // Services on free tiers cost nothing per call.
  calcomPerBookingInr: number;
  telegramPerMessageInr: number;
  hubspotPerDealInr: number;
}

export const DEFAULT_RATES: Rates = {
  usdToInr: 88, // ASSUMPTION
  vaaniPerMinuteInr: null,
  geminiInputPerMTokUsd: 0.3,
  geminiOutputPerMTokUsd: 2.5,
  calcomPerBookingInr: 0,
  telegramPerMessageInr: 0,
  hubspotPerDealInr: 0,
};

export interface CostEntry {
  service: "vaani" | "gemini" | "calcom" | "telegram" | "hubspot";
  units: number;
  unit: "minute" | "input_token" | "output_token" | "request";
  costInr: number | null;
  rateNote?: string;
}

const round = (n: number) => Math.round(n * 10000) / 10000;

export function vaaniCost(durationSec: number, r: Rates = DEFAULT_RATES): CostEntry {
  const minutes = durationSec / 60; // billed fractionally; confirm Vaani's rounding rule
  return {
    service: "vaani", units: round(minutes), unit: "minute",
    costInr: r.vaaniPerMinuteInr === null ? null : round(minutes * r.vaaniPerMinuteInr),
    rateNote: r.vaaniPerMinuteInr === null ? "Vaani rate not yet confirmed" : undefined,
  };
}

export function geminiCost(inputTokens: number, outputTokens: number, r: Rates = DEFAULT_RATES): CostEntry[] {
  const inr = (tok: number, usdPerM: number) => round((tok / 1e6) * usdPerM * r.usdToInr);
  return [
    { service: "gemini", units: inputTokens, unit: "input_token", costInr: inr(inputTokens, r.geminiInputPerMTokUsd) },
    { service: "gemini", units: outputTokens, unit: "output_token", costInr: inr(outputTokens, r.geminiOutputPerMTokUsd) },
  ];
}

export const calcomCost = (r: Rates = DEFAULT_RATES): CostEntry =>
  ({ service: "calcom", units: 1, unit: "request", costInr: r.calcomPerBookingInr });
export const telegramCost = (r: Rates = DEFAULT_RATES): CostEntry =>
  ({ service: "telegram", units: 1, unit: "request", costInr: r.telegramPerMessageInr });
export const hubspotCost = (r: Rates = DEFAULT_RATES): CostEntry =>
  ({ service: "hubspot", units: 1, unit: "request", costInr: r.hubspotPerDealInr });

// Sum of known costs, plus whether any entry was unknown.
export function totalCost(entries: Pick<CostEntry, "costInr">[]): { inr: number; incomplete: boolean } {
  let inr = 0, incomplete = false;
  for (const e of entries) { if (e.costInr === null) incomplete = true; else inr += e.costInr; }
  return { inr: round(inr), incomplete };
}
