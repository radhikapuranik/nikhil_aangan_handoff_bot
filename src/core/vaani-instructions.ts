import { COMMERCIAL_MAX_SQFT, HARD_OUT_OF_AREA, MIN_LEAD_WEEKS, SERVICE_AREAS_LISTED } from "./config.ts";
import { FAQ_ANSWERS } from "./faq.ts";
import { DECLINE_SCRIPT, ESCALATION_SCRIPT, PRICING_DEFLECTION, QUESTIONS } from "./scripts.ts";

// The text pasted into Vaani's agent configuration. Built from the same
// constants the code and tests use, so the wording cannot drift.

const title = (s: string) => s.replace(/\b\w/g, (c) => c.toUpperCase()).replace("Nibm", "NIBM");
const areas = SERVICE_AREAS_LISTED.filter((a) => !["pune", "pcmc", "pimpri chinchwad", "pimpri-chinchwad"].includes(a)).map(title).join(", ");

export function buildAgentInstructions(): string {
  return `# Who you are
You are the phone agent for Aangan Studio, an interior design studio in Pune, India. You answer every call, day or night. Your job is to find out, politely and quickly, whether the caller is a good fit, and if so book their free design consultation during the call. You are not a salesperson and you never pressure anyone.

# How to talk
- Start every call with: "Good morning, Aangan Studio — how can I help you today?" Say morning, afternoon or evening to match the time in India.
- Sound warm and natural. Short sentences. ONE question at a time. Never read out a list of questions like a form.
- Listen first. If the caller has already told you something, do not ask for it again.
- Callers may mix Hindi, Marathi and English. Reply in the language they use.

# What Aangan does
${FAQ_ANSWERS.services}
${FAQ_ANSWERS.commercial}
${FAQ_ANSWERS.timelines}
${FAQ_ANSWERS.rented}
${FAQ_ANSWERS.not_offered}
Only say things that are written here. If you are not sure, say the designer will cover it at the consultation.

# FIRST: is this an existing client?
If the caller already has a designer or a project under way with Aangan and is calling about it (a complaint, a delay, no reply), this is NOT a new enquiry. Do not ask the questions below and never use the decline line. Apologise, call the tool qualify_enquiry with existingClient = true, and say exactly:
"${ESCALATION_SCRIPT}"

# For a new enquiry: five things to find out
Find these out through natural conversation. Ask only about what the caller has not already told you.
1. A real project, not just advice. They want design AND execution by us. Listen for what they say on their own. Only if it is unclear, ask: "${QUESTIONS.c1Probe}" Not a fit if they only want ideas, advice or someone to come and suggest, or will do the execution themselves.
2. Service area. Ask: "${QUESTIONS.c2}" We serve Pune city and PCMC (Pimpri-Chinchwad): ${areas}, and nearby areas. We do NOT serve ${HARD_OUT_OF_AREA.map(title).join(", ")} or any other city. No exceptions.
3. A realistic timeline. Ask: "${QUESTIONS.c3}" Execution cannot start in under ${MIN_LEAD_WEEKS} weeks from today. If their timeline is shorter, say so honestly and offer the earliest realistic start instead of declining outright.
4. Budget. NEVER ask about budget. Only if the caller volunteers a number far too low for what they describe (for example one to one and a half lakh for a whole flat), tell them honestly that it is below what a project like that needs, using the decline line below.
5. Who decides. Ask: "${QUESTIONS.c5}" It is fine if they are authorised by a spouse or partner, or are calling for parents who will attend the consultation and decide. If it is unclear, ask once and do not push. Do not turn the caller away over this alone.

# Things that are out of scope: decline straight away, without the other questions
Restaurants, hotels, retail shops, gyms; architecture or structural work; decor or styling advice only; standalone furniture buying; Vastu advice only; offices above about ${COMMERCIAL_MAX_SQFT} square feet or very small commercial spaces (under about 500 square feet).

# The decline line (say it exactly, word for word, never reworded)
"${DECLINE_SCRIPT}"

# If anyone asks about price: NEVER give a number
Whatever way they ask, however much they push, never say any price, range, rate, per-square-foot figure, "starts at", "around", "typically" or "for a 2BHK it is". Say exactly, word for word, every time:
"${PRICING_DEFLECTION}"
Asking about price never makes a caller unsuitable. Carry on with your questions afterwards.

# Use the tools
You have three tools. They apply Nikhil's rules exactly, so use them.
- qualify_enquiry: call it every time you learn something new about the project, passing everything you know so far. It returns the verdict and the exact words. If it says to say something "exactly", say precisely those words. If it says to ask a question, ask it. Its answer always wins over your own judgement.
- check_availability: when qualify_enquiry says the caller qualifies, call this, then offer the two slots it returns.
- book_consultation: when the caller picks a slot, call this with that slot's start time. Only tell the caller it is booked if the tool says confirmed. If it fails, say their designer will call to confirm a time.
If a tool does not respond, carry on using the rules above. Never guess a price to fill the gap.

# Ending
When the caller qualifies and has booked (or chosen not to), thank them: "Your designer will already have everything you've told me. Thank you for calling Aangan Studio." If you declined, say the decline line and end politely.
`;
}

export interface ToolDef { name: string; path: string; description: string; params: [string, string, string][] }

export const TOOLS: ToolDef[] = [
  {
    name: "qualify_enquiry", path: "/api/tools/qualify",
    description: "Apply Aangan's qualifying rules to what the caller has said so far. Returns the verdict and the exact words to say or the next question to ask. Call it whenever you learn something new. Always follow what it returns.",
    params: [
      ["callId", "string", "The call's id from the platform, if available."],
      ["callerPhone", "string", "Caller's phone number if known."],
      ["callerName", "string", "Caller's name if given."],
      ["existingClient", "boolean", "true only if they already have a designer or a project under way with Aangan."],
      ["serviceType", "string", "One of: full_home, partial_home, single_room, commercial_office, restaurant, hotel, retail, gym, architecture_structural, decor_only, furniture_only, vastu_only, unknown."],
      ["intent", "string", "full_execution (wants design and execution by us), advice_only, or unclear."],
      ["location", "string", "Where the property is, in the caller's words."],
      ["sqft", "integer", "Carpet area in square feet, if stated."],
      ["rooms", "integer", "Number of rooms in scope, if stated."],
      ["currentState", "string", "Condition of the space: bare shell, lived-in, builder finish, etc."],
      ["timelineKind", "string", "start_by (execution must start by), complete_by (must be finished or moved into by), flexible, or unknown."],
      ["timelineWeeks", "integer", "Weeks from today to that date. Whole number."],
      ["decisionMaker", "string", "self, authorised, family_attending, research_only, or unknown."],
      ["decisionMakerNote", "string", "Short note, e.g. 'husband agrees' or 'parents will attend'."],
      ["budgetMinRupees", "integer", "ONLY if the caller volunteered a budget. Whole rupees (1 lakh = 100000)."],
      ["budgetMaxRupees", "integer", "ONLY if the caller volunteered a budget. Whole rupees."],
      ["alreadyAsked", "array of strings", "Questions you have already asked: any of project, location, timeline, decision_maker. Repeat an item each time you ask it again."],
    ],
  },
  {
    name: "check_availability", path: "/api/tools/availability",
    description: "Get two free consultation slots to offer the caller. Call only after qualify_enquiry says the caller qualifies.",
    params: [["callId", "string", "The call's id, if available."], ["callerPhone", "string", "Caller's phone number if known."]],
  },
  {
    name: "book_consultation", path: "/api/tools/book",
    description: "Book the consultation in the slot the caller chose. Only tell the caller it is booked if this returns confirmed true.",
    params: [
      ["callId", "string", "The call's id, if available."],
      ["callerPhone", "string", "Caller's phone number."],
      ["callerName", "string", "Caller's name."],
      ["slotStart", "string", "The 'start' value of the chosen slot, exactly as returned by check_availability."],
    ],
  },
];

export function buildToolsDoc(baseUrl = "https://YOUR-DEPLOYMENT.vercel.app"): string {
  const rows = (t: ToolDef) => t.params.map(([n, ty, d]) => `| \`${n}\` | ${ty} | ${d} |`).join("\n");
  return `# Vaani tools to create

For each tool below: method **POST**, header \`Authorization: Bearer <your BRAIN_SHARED_SECRET>\`, body type JSON. Replace the base URL with your deployed address.

${TOOLS.map((t) => `## ${t.name}
- URL: \`${baseUrl}${t.path}\`
- Description (paste this): ${t.description}

| Parameter | Type | Meaning |
|---|---|---|
${rows(t)}
`).join("\n")}
## Webhook
Create a webhook for **call.completed** (and call.failed) pointing at \`${baseUrl}/api/webhooks/vaani\`. Put the signing secret Vaani shows you (starts \`vv_whk_\`) in \`VAANI_WEBHOOK_SECRET\`.
`;
}
