# Aangan Studio: AI phone agent

An inbound-call agent for Aangan Studio. It answers every call, day or night, runs Nikhil's qualifying conversation, books a consultation for qualified callers during the call, and sends the designer a note with everything already asked. Every call is logged with its outcome and its cost.

**Scope:** incoming phone calls only. WhatsApp and the web form are not built (see [Extending to other channels](#extending-to-other-channels)).

## Status: what is and isn't verified

Be precise about this when asked.

| Piece | Status |
|---|---|
| Qualification logic, scripts, pricing guard, handoff note | **Built and tested** (95 automated tests, all pass; `npm test`) |
| All 20 phone transcripts (T01-T20) | **Run through the logic**, 20/20 agree with expected verdicts (see [Testing](#testing)). This tests the *decisions* given facts, not speech understanding |
| **Booking** | **Verified live through production**: a test consultation was booked via the tool, read back from Cal.com, then cancelled. Found and fixed a bug on the way: Cal.com rejects made-up attendee email domains, so bookings now use a "+" alias of a real inbox (`CALCOM_EMAIL_FALLBACK`) |
| **Vercel deployment** | **Live at https://aangan-phone-agent.vercel.app** (dashboard at `/`, needs the password). Every endpoint is checked from outside: wrong or missing credentials get 401, and a forged webhook is rejected. A real round trip through production reached Neon and Cal.com (two real slots). Test rows removed |
| Call log, cost ledger, dashboard | **Call log and cost ledger verified on the real Neon database** (schema applied; a test call written, read back through the dashboard query, then deleted). Dashboard viewed locally with *sample* data. Not yet run on Vercel |
| **Gemini** (speech to facts) | **Verified live.** The real T01-T20 conversations, read turn by turn by `gemini-3.5-flash-lite` as a live call would, give **19/19 matching verdicts** (`npm run live:extract`). Caveat: I tuned the instructions against these same 19 calls, so this shows the approach works, not how it does on unseen calls |
| Telegram | **Verified live.** A test handoff note (sample data, labelled TEST) was sent to the designers' group through the real adapter |
| Cal.com | **Verified live for reading**: the "Design consultation" event type exists and the slots endpoint returns real availability in the shape the code expects. **No booking has been made yet.** Default availability starts at 9am, so set the working hours to Aangan's in Cal.com |
| HubSpot | **Verified live.** A labelled test deal and contact were created through the real adapter, linked to each other, landed in the default pipeline at "Lead Captured" with no amount set, and were then deleted. The account's pipeline uses custom stage names, so the stage id is set in `.env` |
| **After-call pipeline** (Vaani webhook, judge, script audit, handoff, deal) | **Verified live with real Gemini**: the real T01-T20 conversations replayed as webhooks give **19/19 matching verdicts, twice** (`npm run live:webhook`). Telegram/CRM/calendar were mocked in that run. The webhook receiver matches Vaani's documented `call_postprocessing` format and verifies each call with Vaani's API; no real Vaani event has reached it yet |
| **Vaani** (voice agent, app.vaanivoice.ai) | **Set up and tested in text chat.** The agent "Aangan Studio Phone Desk" is configured with the generated instructions (OpenAI gpt-4o, temperature 0). In chat it asks the right questions, uses the decline line word for word, and the price line word for word apart from "you'd" becoming "you would". **Not yet tested by voice or on a real call.** Vaani's "call finished" notification does not fire for chat tests, so the after-call pipeline has not yet received a real Vaani event |

Nothing here has taken a real call yet.

## What was broken, and what fixes it

| What breaks today | Evidence from the brief | What fixes it |
|---|---|---|
| **Nobody answers outside 10am-7pm.** About a third of enquiries (~66 of ~200 a month) arrive then. | "~33% arrive outside 10am-7pm" | The agent answers every call, any hour. The dashboard shows after-hours calls separately, and the answer time per call (it targets seconds, against Nikhil's five-minute bar) |
| **Half of enquiries get no reply within 48 hours**, and a reply within 1 hour converts at 4x. | "~48% get no response in 48 hrs"; "4x conversion" | Same fix: the first response is on the call itself. A call is never "missed", only handled or hung up on, and both are logged |
| **Leads get lost between people.** T16 and T08 in the transcripts: a call logged days late, a missed call never followed up. | T08, T16 | The call row is created the moment the call is answered. If the voice platform reports a call our server never saw, the webhook logs it anyway. Nothing is silent |
| **Designers get a forwarded message with no context** and spend their first call re-asking. | "first call is spent asking questions the front desk already asked" | A structured handoff note (name, phone, project, area, state of the space, timeline, budget signal, who decides, uncertainty flags, booking) goes to Telegram. The consultation is already booked, and the deal is already in HubSpot |
| **Nikhil pulls his own numbers by hand.** | "pulled his own numbers last month" | The dashboard: enquiries, after-hours share, answer time, outcome split, consultations booked, and the cost of the system itself |
| **Unqualified calls waste designer time**, but declining wrongly loses a ₹8-14 lakh project. | "Average project value ₹8-14 lakh" | Nikhil's five-criteria rubric, implemented exactly. When unsure the lead goes forward *with the uncertainty flagged*, not dropped |

## The one thing deliberately not built

Nikhil asked for the system to "quote our standard per-square-foot pricing". **It does not, and never will on its own.** `pricing.md` says no number, range or per-sq-ft figure may be given, because the real price depends on site, materials and scope (a standard-vs-premium kitchen alone can differ 3x). So the agent says the exact scripted line every time, however the caller rephrases:

> "Pricing depends on the site, the materials you choose, and the scope — your designer will walk you through it in detail at the consultation. I can book that for you right now if you'd like."

Because Vaani's own AI does the speaking, my code cannot rewrite its words, so the rule is enforced in four ways: (1) the exact line and the "never state a number" rule are in the agent's instructions; (2) the `qualify_enquiry` tool returns the exact words for decline, deferral and escalation; (3) **after every call, an audit checks the transcript** for any rupee figure, "lakh" or per-sq-ft figure the agent said, and for whether the scripted line was used when price came up. A breach is stored on the call, shown on the dashboard, and sent to the senior Telegram channel at once; (4) the dashboard shows a script-compliance count. This catches breaches after the fact. It cannot prevent them mid-call. Asking the price never disqualifies a caller.

## Why each tool

| Component | Role | Why this one |
|---|---|---|
| **Claude Code** | Builds and maintains the project | The brief's requirement. Every step is a git commit |
| **Vaani Labs** | Answers calls and speaks (including Indian languages and accents) | Built for India. Hinglish shows up in the enquiries (W03, a WhatsApp thread), so callers may mix languages. Its AI runs the conversation from written instructions, calls my tools for rules and booking, and sends a call-completed notification afterwards |
| **Gemini Flash** (`gemini-3.5-flash-lite`) | Reads what the caller said into structured facts; routes general questions | Cheap and fast (about $0.30/$2.50 per million tokens in/out), so it adds well under ₹1 per call. It only *reads*: every decision is plain code, so verdicts are testable and the scripts can't be reworded |
| **Neon** (Postgres) | Call log, state, cost ledger | Serverless Postgres, free tier, works from Vercel functions. A call's in-progress state lives here, so any server can take the next turn. (Supabase also works: the code supports both) |
| **Cal.com** | Books the consultation inside the call | Free, has an API, books in seconds so there is no separate follow-up step. Needs an attendee email, which phone callers rarely give, so a placeholder is used (see limitations) |
| **Telegram** | Sends the designer handoff | See the next section |
| **HubSpot** | CRM | Qualified calls become deals automatically on the free tier. No deal amount is set, because the agent never estimates value |
| **Vercel** | Hosts the dashboard (and the call endpoints) | Free tier, deploys from GitHub, no server to manage |
| **GitHub** | Version control | Progress saved between sessions |

## Handoff channel: Telegram, not email

I chose Telegram because the handoff only works if a designer sees it in the next few minutes, and designers live on their phones, on site, not in an inbox: a Telegram message buzzes a phone and gets read in seconds, while an email waits for a desk and competes with every other message, which brings back exactly the next-day delay Nikhil is trying to remove. A shared designers' group also lets the whole team see a new lead at once and one person reply "taking this", something a forwarded email can't do. It costs nothing and the message is plain text, so a caller's words can't break or inject formatting. The trade-offs are real and I'd say them out loud: it only works if designers actually use Telegram (to confirm with the team), the group holds phone numbers so membership must be controlled, and it isn't a durable record, which is why every note is also stored in the database and HubSpot deal. Email through Resend would be the fallback if the team won't use Telegram, and it would be a small adapter to add.

## How a call works

```
Caller -> Vaani (answers, speaks; its AI follows the instructions in docs/vaani-agent-instructions.md)
            |-- calls qualify_enquiry  -> my rules: verdict + exact words to say   (existing client: senior team alerted at once)
            |-- calls check_availability / book_consultation -> Cal.com, booked inside the call
            `-- when the call ends: "call.completed" webhook with the transcript
                      |
                      v  my server (Vercel)
                 judge the transcript turn by turn (Gemini reads the facts, plain code decides)
                 audit what the agent said (price quoted? scripted lines used?)
                 qualified -> Telegram handoff note + HubSpot deal
                 everything -> call row + cost rows (Neon); breaches -> senior Telegram alert
Dashboard (Vercel) reads the call log.
```

The decision engine is the same code in every path. What changed is who speaks: Vaani's AI, guided by instructions and my tools, instead of my server writing each line.

## How Vaani is wired

The real platform is **app.vaanivoice.ai** (docs at docs.vaanivoice.ai). What is set up there:

1. **Agent** "Aangan Studio Phone Desk", with the instructions from `docs/vaani-agent-instructions.md` (regenerate with `npm run vaani:docs`), OpenAI gpt-4o at temperature 0, greeting left blank so it follows the instructions.
2. **Webhook** "Aangan call results" for the **Call Post-Processing** event, pointing at `https://aangan-phone-agent.vercel.app/api/webhooks/vaani`. Vaani's webhooks have no documented signature, so the server verifies each event by asking Vaani's API (`call_details`) whether that call exists and fetching the transcript from there. A forged call id gets a 404 and does nothing.
3. **Custom tool** `aangan_desk` is created in Vaani (rules, availability, booking) and the server side is built and tested, but it is **switched off**. In testing, Vaani's AI never called it and instead read the tool's name aloud. It stays off until a voice test shows tool calls working.

Consequences, stated plainly: the agent **cannot book during the call**. It tells the caller the designer will phone to confirm a time, and the handoff note lists free slots for the designer to offer. The existing-client alert goes to the senior Telegram channel **after** the call, not during it.

**Option to restore exact wording and in-call booking: Vaani's "Bring your own LLM" (BYOL).** Vaani can send every turn to my server over a persistent WebSocket, so my engine writes each line and nothing is paraphrased. It needs an always-on server (Vercel cannot hold WebSockets), which means one more hosting account. The turn-by-turn engine for this already exists in the code (`src/session/call-session.ts`).

## Testing

`npm test` runs 95 tests. `npm run live:extract` runs the real conversations through live Gemini (needs `GEMINI_API_KEY`). `npm run test:transcripts` prints the T01-T20 table.

`qualification-logic.md` contains only a **summary** of the validated results, not a per-call table, so I compared against *my reading* of the spec for each call. That reading is mine, and so are the hand-extracted facts, so agreement shows the logic is consistent with the spec, not that it was independently validated.

**Counts match the spec exactly:** 12 qualified, 5 declined, 1 deferred, 1 escalated, T08 ops failure.

| Call | Expected | Build | Note |
|---|---|---|---|
| T01, T06, T12, T15, T20 | qualified | qualified | T15 sits exactly on the 6-week boundary and passes |
| T02, T05, T17 | qualified | qualified, flagged | Transcript never asked who decides, so the live agent asks once; if still unclear it goes forward flagged |
| T11, T13, T14 | qualified | qualified, flagged | Timeline never stated in the transcript; the live agent asks |
| T16 | qualified | qualified, flagged | Almost no detail in the transcript (it's the callback chaser) |
| T03, T04, T10, T18, T19 | declined | declined | Nashik; advice only; budget ₹1-1.5 lakh; 180 sq ft; restaurant |
| T07 | deferred | deferred | Three weeks to Diwali; offered the next realistic start |
| T09 | escalated | escalated | Existing client, senior callback |
| T08 | ops failure | n/a | Missed call. The new system answers every call |

**Spec inconsistency found:** its summary says "19 of 20 non-ops calls" but its categories add to 21. T16 is counted both as qualified and as an ops failure. Note also that T17 is two calls (the first dropped); the dropped one is logged as abandoned.

**No mismatches with the spec's verdicts.** Where I filled gaps in the spec, see the next section.

## Judgment calls for Nikhil to confirm

The spec says the logic is final, so these are only gaps, all marked in the code:

1. **A budget that is clearly too low, on its own, declines.** The decision list doesn't cover it; `qualified.md` says "do not forward", and T10 needs it. "Clearly below" = under 60% of the lowest `pricing.md` figure for that scope (my threshold). Those numbers are used internally and never spoken.
2. **Still unclear after the one follow-up: forward with a flag, not decline.** Losing a ₹8-14 lakh lead costs more than a few designer minutes.
3. **The 500 sq ft commercial minimum** comes from a front-desk line in T18, not `services.md`. It's a setting.
4. **The "8-10 weeks from consultation" site rule isn't enforced.** Applied literally it would fail T01, T12 and T20. Only the 6-week minimum is.
5. **Three lines have no wording in the spec** (the escalation line, the deferral offer, the booking confirmations), and a fallback line if the server fails mid-call. I wrote them; they are marked "NOT IN SPEC".
6. **Extra Pune neighbourhoods** (Kharadi, Nanded City, etc.) are treated as "adjoining areas", since real calls mention them.

## Cost

The ledger records every billable event per call. All rates are estimates until confirmed.

- Voice: **₹5.58 per minute** is the estimate Vaani's dashboard shows for this agent (it can change with the voice and model chosen, and may exclude telephony). OpenAI gpt-4o is bundled into that estimate.
- Gemini: **measured** about ₹0.13 per call (19 real conversations, about 3 model reads each, ₹2.43 in total). Switching off the model's hidden reasoning cut this ~6x; left on, it cost ₹0.80 per single read.
- Cal.com, Telegram, HubSpot, Supabase, Vercel: ₹0 on free tiers.
- A 4-minute call is therefore roughly ₹10 before telephony. If all ~200 monthly enquiries were calls, that is about ₹2,000 a month in usage, plus fixed fees. This is an estimate from documented rates, not a measurement.
- **Unknown or unrecorded costs are never shown as zero.** The dashboard flags the total as incomplete and says why, until fixed fees (number rental, plan fees) are entered.

## Known limitations and what I'd do with more time

- **No real call has happened.** Gemini, Neon, Telegram, HubSpot, Cal.com (booking) and Vercel are verified live. Vaani is verified in text chat only. The first voice test is the next step: it should fire Vaani's call-finished notification and drive the after-call pipeline end to end.
- **Gemini over-reads "self".** It sometimes marks the caller as the decision-maker when they never said (T02), which skips the flag the designer should see. Worth tightening with real calls.
- **The scripts are not guaranteed word for word.** Vaani's AI speaks. At temperature 0 with strict instructions it kept the decline and price lines word for word in chat tests, but a model can still drift. The after-call audit finds breaches and alerts the senior channel; it cannot stop one mid-call. BYOL (above) is the way to guarantee it.
- **No live number.** Testing will be in the browser (WebRTC), so telephony and any Twilio cost are still undecided.
- **Speech understanding is the weak point.** Accents, noise, callers who answer two questions at once, and Hindi/Marathi mixed in. Real calls will need review and tuning, and a human-review queue for low-confidence extractions.
- **Callbacks never close.** Urgent escalations stay on the "Needs a person" list because nothing marks them done. A Telegram reply or dashboard button should.
- **No email for bookings.** Cal.com requires one; a placeholder is used, so Cal.com's own confirmation email won't reach the caller. The confirmation is spoken and the designer gets it by Telegram. Better: send an SMS or WhatsApp confirmation.
- **A deferred caller who says yes isn't booked** into the later window; the call is logged as deferred.
- **Weekends:** the transcripts disagree on whether Saturday is open, so "after hours" is simply outside 10am-7pm on any day.
- **Latency metric** is how fast the system picked up as reported by the voice platform. It doesn't capture a caller who waited on hold or had a failed call.
- **Security basics:** one shared dashboard password and one shared secret for the brain. Good enough for a pilot; for production use real sign-in, and review who is in the Telegram group.
- **Privacy:** calls are recorded in transcripts. Indian call-recording consent rules and a spoken disclosure line need a decision from Nikhil before going live.
- **Deploy untested:** the Vercel setup follows its conventions but hasn't been run there.

## Extending to other channels

The qualification logic knows nothing about phones: it takes extracted facts and returns a verdict and the next thing to say. That's the part that carries over.

- **WhatsApp:** replace the voice adapter with the WhatsApp Business API webhook. Each inbound message goes to the same `turn` handler, keyed by the sender's number; the reply is sent as text. The same engine, scripts, booking, handoff and CRM steps apply. After-hours WhatsApp messages (like W01 and W05 in the transcripts, left unanswered until the next working day) would be answered at once.
- **Web form:** a form submission already holds the facts (location, area, timeline, budget, who decides), so it skips the questions and goes straight to the engine. The form's budget field is a stated number, so the budget check applies there; qualified submissions would be booked by sending the caller a calendar link by SMS or email.
- **Shared pieces:** one call log and one dashboard for all three channels (the `channel` column exists; it's constrained to phone today).

## Deploying

Vercel does not bundle the shared code the functions import, so each function in `api-src/` is bundled into one file in `api/` by esbuild. After changing any code run:

```bash
npm run build:api     # api-src/*.ts  ->  api/*.js (commit the result)
vercel deploy --prod
```

Environment variables live in Vercel's production settings (secrets marked sensitive). Never commit `.env`.

## Running it

Requires Node 22.18+ (or 24). No dependencies to install.

```bash
npm test                  # 95 tests
npm run test:transcripts  # T01-T20 table
npm run simulate          # talk to the old turn-by-turn brain in the terminal (mock services)
npm run vaani:docs        # regenerate the text to paste into Vaani (docs/)
npm run live:webhook      # replay T01-T20 through the real after-call pipeline with live Gemini
npm run dashboard:dev     # dashboard with SAMPLE data on :8788, password "demo"
npm run serve             # local call endpoints on :8787
```

Without keys everything runs on mocks. Each service switches to the real one as soon as its keys are in `.env` (copy `.env.example`). Database setup: put `DATABASE_URL` in `.env` and run `npm run db:migrate` (applies `db/migrations/*.sql` once each). `npm run db:smoke` writes and deletes one test call to check the connection.

## Layout

```
src/core/         rules: config, scripts, qualification, pricing guard, FAQ, costs, handoff
src/session/      the live call (resumable from the database)
src/integrations/ Gemini, Cal.com, Telegram, HubSpot (+ mocks)
src/voice/        brain endpoints and the Vaani webhook receiver
src/db/           repositories, recorder, summaries, dashboard data
src/fixtures/     T01-T20 as facts, harness, sample-data seed
public/, api/     dashboard page and Vercel functions
db/migrations/    SQL
test/             95 tests
```
