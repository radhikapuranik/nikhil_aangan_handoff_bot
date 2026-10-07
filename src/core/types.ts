export type ServiceType =
  | "full_home" | "partial_home" | "single_room" | "commercial_office"
  | "restaurant" | "hotel" | "retail" | "gym"
  | "architecture_structural" | "decor_only" | "furniture_only" | "vastu_only"
  | "unknown";

export type Intent = "full_execution" | "advice_only" | "unclear";

// weeks = weeks from the call date. "start_by": execution must start by then.
// "complete_by": the project must be finished by then.
export interface Timeline {
  kind: "start_by" | "complete_by" | "flexible" | "unknown";
  weeks: number | null;
}

export type DecisionMaker =
  | "self" | "authorised" | "family_attending" | "research_only" | "unknown";

// Facts extracted from the caller's speech (by Gemini in production, by hand
// in the transcript fixtures). The decision logic only ever sees this object.
export interface CallFacts {
  callerName?: string | null;
  phone?: string | null;
  existingClient: boolean;
  serviceType: ServiceType;
  intent: Intent;
  location: string | null;
  sqft: number | null;
  rooms: number | null; // rooms in scope, for partial projects
  currentState: string | null; // bare shell, lived-in, builder finish...
  timeline: Timeline;
  decisionMaker: DecisionMaker;
  decisionMakerNote?: string | null;
  budgetLakh: { min: number; max: number } | null; // only if volunteered
}

export type Criterion = "c1" | "c2" | "c3" | "c4" | "c5";
export type CheckStatus = "pass" | "fail" | "unclear";
export type Checks = Record<Criterion, CheckStatus>;

export type VerdictKind =
  | "qualified" | "declined" | "deferred" | "escalated" | "needs_followup";

export interface Decision {
  verdict: VerdictKind;
  checks: Checks | null; // null when qualification was skipped
  reasons: string[];
  flags: string[]; // uncertainty to put in the designer handoff note
  say: string | null; // exact words the agent speaks next
  ask?: Criterion; // which criterion the question is for
  earliestStart?: string; // deferred only
}

// How many times each criterion has been asked about on this call.
export type AskedCounts = Partial<Record<Criterion, number>>;
