import type { CostEntry } from "../core/costs.ts";
import type { CallRecord, DateRange, FixedCost, NewCall, StoredCost } from "./types.ts";

export interface CallRepository {
  createCall(c: NewCall): Promise<CallRecord>;
  updateCall(id: string, patch: Partial<Omit<CallRecord, "id">>): Promise<CallRecord>;
  getByProviderCallId(providerCallId: string): Promise<CallRecord | null>;
  addCosts(callId: string, entries: CostEntry[]): Promise<void>;
  listCalls(range: DateRange): Promise<CallRecord[]>;
  listCosts(range: DateRange): Promise<StoredCost[]>;
  listFixedCosts(): Promise<FixedCost[]>;
  addFixedCost(f: FixedCost): Promise<void>;
  // false if this provider event id was already stored (a webhook retry).
  recordProviderEvent(e: { id: string; type: string; payload: unknown }): Promise<boolean>;
}

export const emptyCall = (c: NewCall): Omit<CallRecord, "id"> => ({
  providerCallId: null, endedAt: null, durationSec: null, answerLatencyMs: null,
  afterHours: false, callerPhone: null, callerName: null, transcript: [],
  facts: null, checks: null, verdict: "in_progress", reasons: [], flags: [],
  pricingAsked: false, handoffStatus: "not_applicable", handoffSentAt: null,
  bookingStatus: "not_applicable", bookingTime: null, bookingRef: null,
  crmStatus: "not_applicable", crmDealId: null, sessionState: null,
  ...c,
});
