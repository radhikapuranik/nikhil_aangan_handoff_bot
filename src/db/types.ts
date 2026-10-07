import type { CallFacts, Checks } from "../core/types.ts";
import type { CostEntry } from "../core/costs.ts";

export type DbVerdict = "in_progress" | "qualified" | "declined" | "deferred" | "escalated" | "abandoned";
export type HandoffStatus = "not_applicable" | "pending" | "sent" | "failed" | "escalation_pending" | "escalation_done";
export type BookingStatus = "not_applicable" | "offered" | "booked" | "declined_by_caller" | "failed";
export type CrmStatus = "not_applicable" | "pending" | "created" | "failed";

export interface TranscriptTurn { speaker: "agent" | "caller"; text: string; at: string }

export interface CallRecord {
  id: string;
  providerCallId: string | null;
  startedAt: string; // ISO
  endedAt: string | null;
  durationSec: number | null;
  answerLatencyMs: number | null;
  afterHours: boolean;
  callerPhone: string | null;
  callerName: string | null;
  transcript: TranscriptTurn[];
  facts: CallFacts | null;
  checks: Checks | null;
  verdict: DbVerdict;
  reasons: string[];
  flags: string[];
  pricingAsked: boolean;
  handoffStatus: HandoffStatus;
  handoffSentAt: string | null;
  bookingStatus: BookingStatus;
  bookingTime: string | null;
  bookingRef: string | null;
  crmStatus: CrmStatus;
  crmDealId: string | null;
  sessionState: unknown | null; // in-call state, so any server instance can resume the call
}

export type NewCall = Pick<CallRecord, "startedAt"> & Partial<Omit<CallRecord, "id" | "startedAt">>;

export interface StoredCost extends CostEntry { id: string; callId: string; createdAt: string }

export interface FixedCost { service: string; monthlyInr: number | null; activeFrom: string; activeTo: string | null }

export interface DateRange { from: string; to: string } // ISO, [from, to)
