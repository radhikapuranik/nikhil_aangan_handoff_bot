import {
  BUDGET_CLEARLY_BELOW_RATIO, BUDGET_FLOOR_LAKH, COMMERCIAL_MAX_SQFT,
  COMMERCIAL_MIN_SQFT, HARD_OUT_OF_AREA, MIN_LEAD_WEEKS, OTHER_CITIES,
  SERVICE_AREAS_ADJOINING, SERVICE_AREAS_LISTED,
} from "./config.ts";
import {
  DECLINE_SCRIPT, ESCALATION_SCRIPT, QUESTIONS, deferralScript,
} from "./scripts.ts";
import type {
  AskedCounts, CallFacts, CheckStatus, Checks, Criterion, Decision, ServiceType,
} from "./types.ts";

const OUT_OF_SCOPE: Partial<Record<ServiceType, string>> = {
  restaurant: "restaurant (hospitality) is out of scope",
  hotel: "hotel (hospitality) is out of scope",
  retail: "retail is out of scope",
  gym: "gym is out of scope",
  architecture_structural: "architecture/structural work is out of scope",
  decor_only: "decor/styling only is out of scope",
  furniture_only: "standalone furniture sourcing is out of scope",
  vastu_only: "Vastu-only consultation is out of scope",
};

const has = (haystack: string, needles: string[]) =>
  needles.some((n) => haystack.includes(n));

// ---- the five checks -------------------------------------------------------

function checkRealProject(f: CallFacts): CheckStatus {
  if (f.intent === "advice_only") return "fail";
  if (f.intent === "full_execution") return "pass";
  return "unclear";
}

function checkServiceArea(f: CallFacts): CheckStatus {
  if (!f.location) return "unclear";
  const loc = f.location.toLowerCase();
  if (has(loc, HARD_OUT_OF_AREA) || has(loc, OTHER_CITIES)) return "fail";
  if (has(loc, SERVICE_AREAS_LISTED) || has(loc, SERVICE_AREAS_ADJOINING)) return "pass";
  return "unclear"; // a place we don't recognise: ask once whether it is Pune/PCMC
}

function checkTimeline(f: CallFacts): CheckStatus {
  const t = f.timeline;
  if (t.kind === "flexible") return "pass";
  if (t.kind === "unknown" || t.weeks === null) return "unclear";
  return t.weeks < MIN_LEAD_WEEKS ? "fail" : "pass";
}

function budgetFloorLakh(f: CallFacts): number {
  const sqft = f.sqft ?? 0;
  if (f.serviceType === "single_room") return BUDGET_FLOOR_LAKH.singleRoom;
  if (f.serviceType === "partial_home") return BUDGET_FLOOR_LAKH.singleRoom;
  if (f.serviceType === "commercial_office")
    return Math.max(BUDGET_FLOOR_LAKH.singleRoom, sqft * BUDGET_FLOOR_LAKH.perSqftCommercial);
  return Math.max(BUDGET_FLOOR_LAKH.singleRoom, sqft * BUDGET_FLOOR_LAKH.perSqftHome);
}

// Never probed. No number volunteered counts as a pass.
function checkBudget(f: CallFacts): { status: CheckStatus; borderline: boolean } {
  if (!f.budgetLakh) return { status: "pass", borderline: false };
  const floor = budgetFloorLakh(f);
  if (f.budgetLakh.max < floor * BUDGET_CLEARLY_BELOW_RATIO)
    return { status: "fail", borderline: false };
  return { status: "pass", borderline: f.budgetLakh.max < floor };
}

function checkDecisionMaker(f: CallFacts): CheckStatus {
  if (f.decisionMaker === "self" || f.decisionMaker === "authorised" || f.decisionMaker === "family_attending")
    return "pass";
  return "unclear"; // research_only and unknown never fail on their own
}

// ---- decision --------------------------------------------------------------

function earliestStartDate(today: Date): string {
  const d = new Date(today.getTime() + MIN_LEAD_WEEKS * 7 * 86400000);
  return d.toLocaleDateString("en-IN", { day: "numeric", month: "long", year: "numeric" });
}

export function evaluate(
  f: CallFacts,
  asked: AskedCounts = {},
  today: Date = new Date(),
): Decision {
  // Pre-check: an existing client is never a new enquiry.
  if (f.existingClient) {
    return {
      verdict: "escalated", checks: null,
      reasons: ["existing project issue; qualification skipped"],
      flags: [], say: ESCALATION_SCRIPT,
    };
  }

  // Out-of-scope service type: decline immediately, no checklist.
  const oos = OUT_OF_SCOPE[f.serviceType];
  if (oos) {
    return { verdict: "declined", checks: null, reasons: [oos], flags: [], say: DECLINE_SCRIPT };
  }
  if (f.serviceType === "commercial_office" && f.sqft !== null) {
    if (f.sqft < COMMERCIAL_MIN_SQFT)
      return {
        verdict: "declined", checks: null,
        reasons: [`commercial space of ${f.sqft} sq ft is below the ${COMMERCIAL_MIN_SQFT} sq ft minimum scope`],
        flags: [], say: DECLINE_SCRIPT,
      };
    if (f.sqft > COMMERCIAL_MAX_SQFT)
      return {
        verdict: "declined", checks: null,
        reasons: [`commercial space of ${f.sqft} sq ft is above the ~${COMMERCIAL_MAX_SQFT} sq ft maximum`],
        flags: [], say: DECLINE_SCRIPT,
      };
  }

  const budget = checkBudget(f);
  const checks: Checks = {
    c1: checkRealProject(f),
    c2: checkServiceArea(f),
    c3: checkTimeline(f),
    c4: budget.status,
    c5: checkDecisionMaker(f),
  };
  const labels: Record<Criterion, string> = {
    c1: "not a real project (advice only)",
    c2: "outside service area",
    c3: "timeline under the 6-week minimum lead time",
    c4: "volunteered budget clearly below scope",
    c5: "decision-maker",
  };
  const failed = (Object.keys(checks) as Criterion[]).filter((c) => checks[c] === "fail");
  const reasonsFor = (cs: Criterion[]) => cs.map((c) => labels[c]);

  // 2+ fail -> decline.
  if (failed.length >= 2)
    return { verdict: "declined", checks, reasons: reasonsFor(failed), flags: [], say: DECLINE_SCRIPT };

  // Criterion 1 or 2 failing outright -> decline.
  if (checks.c1 === "fail" || checks.c2 === "fail")
    return { verdict: "declined", checks, reasons: reasonsFor(failed), flags: [], say: DECLINE_SCRIPT };

  // Criterion 4 failing alone: spec is silent; qualified.md says "do not forward".
  if (checks.c4 === "fail")
    return { verdict: "declined", checks, reasons: reasonsFor(failed), flags: [], say: DECLINE_SCRIPT };

  // Criterion 3 failing alone: offer the next realistic start, not a decline.
  if (checks.c3 === "fail") {
    const start = earliestStartDate(today);
    return {
      verdict: "deferred", checks, reasons: reasonsFor(failed), flags: [],
      say: deferralScript(start), earliestStart: start,
    };
  }

  // Unclear on 1-3: ask before deciding either way.
  const n = (c: Criterion) => asked[c] ?? 0;
  const flags: string[] = [];
  const next = nextQuestion(checks, n);
  if (next) return { verdict: "needs_followup", checks, reasons: [], flags: [], say: next.say, ask: next.ask };

  // Anything still unclear after being asked goes forward, flagged. A lost
  // Rs 8-14 lakh lead costs more than a few designer minutes.
  if (checks.c1 === "unclear") flags.push("Not confirmed that this is a full design + execution project");
  if (checks.c2 === "unclear") flags.push("Location not confirmed as within Pune/PCMC");
  if (checks.c3 === "unclear") flags.push("Timeline not stated or confirmed");
  if (checks.c5 === "unclear") flags.push("Decision-maker not confirmed" + (f.decisionMakerNote ? ` (${f.decisionMakerNote})` : ""));
  if (budget.borderline) flags.push("Volunteered budget is borderline for the described scope");

  return { verdict: "qualified", checks, reasons: [], flags, say: null };
}

// Questions are asked in rubric order. Criteria 1-3 get one follow-up.
// Criterion 5 is asked once and never pushed.
function nextQuestion(
  checks: Checks,
  asked: (c: Criterion) => number,
): { ask: Criterion; say: string } | null {
  if (checks.c1 === "unclear" && asked("c1") < 1) return { ask: "c1", say: QUESTIONS.c1Probe };
  if (checks.c2 === "unclear") {
    if (asked("c2") < 1) return { ask: "c2", say: QUESTIONS.c2 };
    if (asked("c2") < 2) return { ask: "c2", say: QUESTIONS.c2FollowUp };
  }
  if (checks.c3 === "unclear") {
    if (asked("c3") < 1) return { ask: "c3", say: QUESTIONS.c3 };
    if (asked("c3") < 2) return { ask: "c3", say: QUESTIONS.c3FollowUp };
  }
  if (checks.c5 === "unclear" && asked("c5") < 1) return { ask: "c5", say: QUESTIONS.c5 };
  return null;
}
