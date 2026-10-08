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
If the caller already has a designer or a project under way with Aangan and is calling about it (a complaint, a delay, no reply), this is NOT a new enquiry. Do not ask the questions below and never use the decline line. Apologise, call aangan_desk with action = "qualify" and existingClient = true, and say exactly:
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

# Use the tool aangan_desk
You have one tool, aangan_desk. It applies Nikhil's rules exactly, so use it. Always set its action field:
- action = "qualify": call it every time you learn something new about the project, passing everything you know so far. It returns the verdict and the exact words. If it says to say something "exactly", say precisely those words. If it says to ask a question, ask it. Its answer always wins over your own judgement.
- action = "availability": when qualify says the caller qualifies, call this, then offer the two slots it returns.
- action = "book": when the caller picks a slot, call this with slotStart set to that slot's start value. Only tell the caller it is booked if the tool says confirmed is true. If it fails, say their designer will call to confirm a time.
If the tool does not respond, carry on using the rules above. Never guess a price to fill the gap.

# Ending
When the caller qualifies and has booked (or chosen not to), thank them: "Your designer will already have everything you've told me. Thank you for calling Aangan Studio." If you declined, say the decline line and end politely.
`;
}

export interface ToolDef { name: string; path: string; description: string; params: [string, string, string][] }

export const TOOLS: ToolDef[] = [
  {
    name: "aangan_desk", path: "/api/tools/desk",
    description: "Aangan Studio's rules desk. Use action 'qualify' every time you learn something new about the caller's project: it returns the verdict and the exact words to say or the next question to ask, and you must follow it. After a caller qualifies, use action 'availability' to get two consultation slots, then action 'book' with the slot the caller chose. Only tell the caller a booking is confirmed if the result says confirmed is true.",
    params: [
      ["action", "string", "REQUIRED. One of: qualify, availability, book."],
      ["callerPhone", "string", "Caller's phone number if known."],
      ["callerName", "string", "Caller's name if given."],
      ["existingClient", "boolean", "qualify: true only if they already have a designer or a project under way with Aangan."],
      ["serviceType", "string", "qualify: one of full_home, partial_home, single_room, commercial_office, restaurant, hotel, retail, gym, architecture_structural, decor_only, furniture_only, vastu_only, unknown."],
      ["intent", "string", "qualify: full_execution (wants design and execution by us), advice_only, or unclear."],
      ["location", "string", "qualify: where the property is, in the caller's words."],
      ["sqft", "number", "qualify: carpet area in square feet, if stated."],
      ["rooms", "number", "qualify: number of rooms in scope, if stated."],
      ["currentState", "string", "qualify: condition of the space: bare shell, lived-in, builder finish, etc."],
      ["timelineKind", "string", "qualify: start_by (execution must start by), complete_by (must be finished or moved into by), flexible, or unknown."],
      ["timelineWeeks", "number", "qualify: whole weeks from today to that date."],
      ["decisionMaker", "string", "qualify: self, authorised, family_attending, research_only, or unknown."],
      ["decisionMakerNote", "string", "qualify: short note, e.g. 'husband agrees' or 'parents will attend'."],
      ["budgetMinRupees", "number", "qualify: ONLY if the caller volunteered a budget. Whole rupees (1 lakh = 100000)."],
      ["budgetMaxRupees", "number", "qualify: ONLY if the caller volunteered a budget. Whole rupees."],
      ["alreadyAsked", "string", "qualify: comma-separated questions you have already asked: project, location, timeline, decision_maker. Repeat an item each time you ask it again."],
      ["slotStart", "string", "book: the 'start' value of the slot the caller chose, exactly as returned by action availability."],
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
