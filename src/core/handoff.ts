import type { CallFacts, Decision } from "./types.ts";

export interface BookingInfo { booked: boolean; when?: string }

// Field order follows "Handoff note format" in qualification-logic.md.
export function buildHandoffNote(f: CallFacts, d: Decision, booking: BookingInfo): string {
  const budget = f.budgetLakh
    ? `Rs ${f.budgetLakh.min}-${f.budgetLakh.max} lakh volunteered` +
      (d.flags.some((x) => x.includes("budget")) ? " (BORDERLINE)" : "")
    : "None volunteered";
  const dm: Record<CallFacts["decisionMaker"], string> = {
    self: "Direct (caller decides)",
    authorised: "Represented (caller authorised by partner)",
    family_attending: "Represented (family will attend and decide)",
    research_only: "UNCLEAR: caller is researching for someone else",
    unknown: "UNCLEAR: not confirmed",
  };
  const t = f.timeline;
  const timeline =
    t.kind === "flexible" ? "Flexible"
    : t.kind === "unknown" || t.weeks === null ? "Not stated"
    : `${t.kind === "start_by" ? "Start" : "Complete"} within ~${t.weeks} weeks`;

  return [
    `NEW QUALIFIED LEAD`,
    `Caller: ${f.callerName ?? "(name not given)"} | ${f.phone ?? "(phone not captured)"}`,
    `Project: ${f.serviceType.replace(/_/g, " ")} | ${f.location ?? "location unknown"} | ${f.sqft ? f.sqft + " sq ft" : "size not given"}`,
    `Current state of space: ${f.currentState ?? "not stated"}`,
    `Timeline: ${timeline}`,
    `Budget signal: ${budget}`,
    `Decision-maker: ${dm[f.decisionMaker]}${f.decisionMakerNote ? " — " + f.decisionMakerNote : ""}`,
    `Uncertainty flags: ${d.flags.length ? d.flags.join("; ") : "none"}`,
    `Consultation booked: ${booking.booked ? "YES" + (booking.when ? " — " + booking.when : "") : "no"}`,
  ].join("\n");
}
