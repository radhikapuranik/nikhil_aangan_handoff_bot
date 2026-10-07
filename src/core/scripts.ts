// Verbatim scripts from qualification-logic.md. Do not edit wording.
// Anything marked "NOT IN SPEC" is wording the spec describes but does not
// supply, so it needs Nikhil's sign-off.

export const PRICING_DEFLECTION =
  "Pricing depends on the site, the materials you choose, and the scope — your designer will walk you through it in detail at the consultation. I can book that for you right now if you'd like.";

export const DECLINE_SCRIPT =
  "This sounds like it may not be the right fit for us right now — but feel free to reach out if your timeline or scope changes.";

export function openingLine(hour: number): string {
  const part = hour < 12 ? "morning" : hour < 17 ? "afternoon" : "evening";
  return `Good ${part}, Aangan Studio — how can I help you today?`;
}

export const QUESTIONS = {
  c1Probe:
    "And are you looking for a full redesign with our team handling everything, or just some direction on what to do?",
  c2: "Whereabouts is the property?",
  // NOT IN SPEC: spec says "ask one direct follow-up" without wording.
  c2FollowUp: "Just to confirm, is that within Pune or Pimpri-Chinchwad?",
  c3: "What timeline are you working with?",
  // From qualified.md.
  c3FollowUp: "When would you need the project complete?",
  c5: "Will you be the one deciding on this, or is someone else involved too?",
} as const;

// NOT IN SPEC: spec says "apologize, escalate to a senior staff callback
// within 15 minutes" but gives no wording.
export const ESCALATION_SCRIPT =
  "I'm very sorry about that. I'm getting this to our senior team right now, and someone senior will call you back within 15 minutes.";

// NOT IN SPEC: spec says "say so honestly and offer the next realistic start
// window". The date is filled in by the caller.
export function deferralScript(earliestStart: string): string {
  return `I want to be honest with you: we need at least six weeks before execution can begin, so we couldn't do this justice in that time. The earliest we could realistically start is around ${earliestStart}. Would you like me to book a consultation for that window?`;
}
