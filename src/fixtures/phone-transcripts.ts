import type { CallFacts } from "../core/types.ts";

// Facts hand-extracted from T01-T20 in "Aangan_Sep 2026_Enquiries.pdf".
// These test the DECISION logic given facts. They do not test speech
// extraction, which is Gemini's job and is tested separately with live calls.
//
// "expected" is MY reading of the spec for each call. qualification-logic.md
// has only a summary of counts, not a per-transcript table. See the harness.

export type Expected = "qualified" | "declined" | "deferred" | "escalated" | "ops_failure";

export interface Fixture {
  id: string;
  summary: string;
  expected: Expected;
  facts: CallFacts | null; // null = nothing to evaluate (missed or dropped call)
  pricingQuestions?: string[]; // caller lines that ask for a price
  note?: string;
}

const base: CallFacts = {
  existingClient: false, serviceType: "unknown", intent: "unclear",
  location: null, sqft: null, rooms: null, currentState: null,
  timeline: { kind: "unknown", weeks: null }, decisionMaker: "unknown",
  budgetLakh: null,
};
const f = (p: Partial<CallFacts>): CallFacts => ({ ...base, ...p });

export const PHONE_FIXTURES: Fixture[] = [
  { id: "T01", summary: "3BHK Kothrud, full redo, done by March, husband agrees", expected: "qualified",
    facts: f({ callerName: "Priya", serviceType: "full_home", intent: "full_execution", location: "Kothrud (Dahanukar Colony)", sqft: 1400, currentState: "lived-in, builder finish", timeline: { kind: "complete_by", weeks: 26 }, decisionMaker: "authorised", decisionMakerNote: "husband aware and happy to go ahead" }) },

  { id: "T02", summary: "2BHK Wakad, full redesign, asks price twice", expected: "qualified",
    facts: f({ serviceType: "full_home", intent: "full_execution", location: "Wakad", sqft: 950, currentState: "moving in November", timeline: { kind: "complete_by", weeks: 8 } }),
    pricingQuestions: ["can you tell me roughly how much something like that would cost?", "can you give me a rough ballpark first? Even a range?"],
    note: "Decision-maker never asked in transcript" },

  { id: "T03", summary: "Home office and study in Nashik", expected: "declined",
    facts: f({ callerName: "Suresh Patil", serviceType: "partial_home", rooms: 2, location: "Nashik" }) },

  { id: "T04", summary: "Living room: just ideas on colours and arrangement", expected: "declined",
    facts: f({ serviceType: "single_room", rooms: 1, intent: "advice_only" }) },

  { id: "T05", summary: "4BHK Koregaon Park, complete redesign, ~4 months", expected: "qualified",
    facts: f({ callerName: "Aarti Mehta", serviceType: "full_home", intent: "full_execution", location: "Koregaon Park", sqft: 2400, currentState: "family moved out temporarily", timeline: { kind: "complete_by", weeks: 17 } }),
    note: "Decision-maker never asked in transcript" },

  { id: "T06", summary: "800 sq ft startup office, Baner, founder", expected: "qualified",
    facts: f({ serviceType: "commercial_office", intent: "full_execution", location: "Baner", sqft: 800, currentState: "bare shell", timeline: { kind: "complete_by", weeks: 12 }, decisionMaker: "self", decisionMakerNote: "founder" }) },

  { id: "T07", summary: "Living room + kitchen before Diwali (3 weeks), then 'start after Diwali'", expected: "deferred",
    facts: f({ serviceType: "partial_home", rooms: 2, intent: "full_execution", timeline: { kind: "complete_by", weeks: 3 }, decisionMaker: "self" }) },

  { id: "T08", summary: "Missed call 10:47pm, no voicemail, callback unanswered", expected: "ops_failure", facts: null,
    note: "Operational failure. The new system answers every call, so there is nothing to classify." },

  { id: "T09", summary: "Existing client: designer silent for 5 days", expected: "escalated",
    facts: f({ callerName: "Sheetal Deshpande", existingClient: true, location: "Viman Nagar" }) },

  { id: "T10", summary: "1BHK Kharadi kitchen + bedroom, budget Rs 1-1.5 lakh max", expected: "declined",
    facts: f({ serviceType: "partial_home", rooms: 2, intent: "full_execution", location: "Kharadi", sqft: 550, budgetLakh: { min: 1, max: 1.5 } }) },

  { id: "T11", summary: "Rented 2BHK Baner, living + bedroom + kitchen, no structural", expected: "qualified",
    facts: f({ serviceType: "partial_home", rooms: 3, intent: "full_execution", location: "Baner", currentState: "rented, bare", decisionMaker: "self", decisionMakerNote: "tenant on 3-year lease, landlord approved" }),
    note: "Timeline never stated in transcript" },

  { id: "T12", summary: "5,500 sq ft villa Kalyani Nagar, new, move in March", expected: "qualified",
    facts: f({ callerName: "Anand Sharma", serviceType: "full_home", intent: "full_execution", location: "Kalyani Nagar", sqft: 5500, currentState: "new construction, empty", timeline: { kind: "complete_by", weeks: 24 }, decisionMaker: "self" }) },

  { id: "T13", summary: "3BHK Aundh 1,100 sq ft, asks for a rough range", expected: "qualified",
    facts: f({ serviceType: "full_home", intent: "full_execution", location: "Aundh", sqft: 1100, decisionMaker: "self" }),
    pricingQuestions: ["What might it cost?", "can't you give me even a rough range? I just want to know if we're in the same ballpark."],
    note: "Timeline never stated in transcript" },

  { id: "T14", summary: "Son calling for parents' new 3BHK Hadapsar; parents will attend", expected: "qualified",
    facts: f({ serviceType: "full_home", intent: "full_execution", location: "Hadapsar", currentState: "new possession", decisionMaker: "family_attending", decisionMakerNote: "caller is the son; parents own the flat and will attend and decide" }),
    note: "Timeline never stated. 'Proper design' read as a full project." },

  { id: "T15", summary: "2BHK Undri 875 sq ft, possession in 6 weeks", expected: "qualified",
    facts: f({ callerName: "Smita", serviceType: "full_home", intent: "full_execution", location: "Undri", sqft: 875, currentState: "awaiting possession; builder allows site access", timeline: { kind: "start_by", weeks: 6 }, decisionMaker: "authorised", decisionMakerNote: "husband said to go ahead" }),
    note: "Exactly at the 6-week boundary" },

  { id: "T16", summary: "Callback chaser: 3BHK Viman Nagar, earlier lead never logged", expected: "qualified",
    facts: f({ callerName: "Girish Nair", serviceType: "full_home", location: "Viman Nagar" }),
    note: "Spec counts this as qualified AND as an ops failure. Transcript holds almost no qualifying detail." },

  { id: "T17", summary: "First call dropped; second call: 3BHK Pimple Saudagar 1,050 sq ft", expected: "qualified",
    facts: f({ callerName: "Ritu Kapoor", serviceType: "full_home", intent: "full_execution", location: "Pimple Saudagar", sqft: 1050, currentState: "lived-in, builder furniture", timeline: { kind: "complete_by", weeks: 23 } }),
    note: "Dropped first call must be logged as abandoned. Decision-maker never asked." },

  { id: "T18", summary: "180 sq ft coworking pod", expected: "declined",
    facts: f({ serviceType: "commercial_office", sqft: 180 }),
    note: "Relies on the 500 sq ft floor, which is only in the transcript, not services.md" },

  { id: "T19", summary: "Restaurant in Koregaon Park", expected: "declined",
    facts: f({ serviceType: "restaurant", location: "Koregaon Park" }) },

  { id: "T20", summary: "2BHK Magarpatta 900 sq ft, January start, both attend", expected: "qualified",
    facts: f({ callerName: "Pooja", serviceType: "full_home", intent: "full_execution", location: "Magarpatta", sqft: 900, timeline: { kind: "start_by", weeks: 14 }, decisionMaker: "authorised", decisionMakerNote: "husband will attend the consultation" }) },
];

// What qualification-logic.md says about the 20 calls.
export const SPEC_SUMMARY = { qualified: 12, declined: 5, deferred: 1, escalated: 1, ops_failure_only: 1 };
