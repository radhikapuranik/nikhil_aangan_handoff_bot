# Aangan Studio: AI phone agent

An inbound-call agent for Aangan Studio. It answers every call, day or night, runs Nikhil's qualifying conversation, books a consultation for qualified callers during the call, and sends the designer a note with everything already asked. Every call is logged with its outcome and its cost.

**Scope:** incoming phone calls only. WhatsApp and the web form are not built (see [Extending to other channels](#extending-to-other-channels)).

## Status: what is and isn't verified

Be precise about this when asked.

| Piece | Status |
|---|---|
| Qualification logic, scripts, pricing guard, handoff note | **Built and tested** (81 automated tests, all pass; `npm test`) |
| All 20 phone transcripts (T01-T20) | **Run through the logic**, 20/20 agree with expected verdicts (see [Testing](#testing)). This tests the *decisions* given facts, not speech understanding |
| Call log, cost ledger, dashboard | **Call log and cost ledger verified on the real Neon database** (schema applied; a test call written, read back through the dashboard query, then deleted). Dashboard viewed locally with *sample* data. Not yet run on Vercel |
| **Gemini** (speech to facts) | **Verified live.** The real T01-T20 conversations, read turn by turn by `gemini-3.5-flash-lite` as a live call would, give **19/19 matching verdicts** (`npm run live:extract`). Caveat: I tuned the instructions against these same 19 calls, so this shows the approach works, not how it does on unseen calls |
| Telegram, Cal.com | **Credentials verified** with read-only calls (bot sees the group; event types listed). No message sent and no booking made yet. The Cal.com slots endpoint is from memory, not docs |
| HubSpot | **Written to the documented API, but the token lacks the Deals permission**, so it has never created a deal |
| **Vaani Labs voice link** | **Not confirmed.** Vaani's public docs show no way for outside code to steer a call turn by turn. See [Open risk: Vaani](#open-risk-vaani) |

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

Three layers enforce it, so a model slip can't leak a number: (1) a detector recognises price questions in many phrasings, including Hinglish; (2) the answer is a fixed string, never model-written; (3) a final check blocks any rupee amount, "lakh", or per-sq-ft figure in anything the agent is about to say, replacing it with the scripted line. Asking the price never disqualifies a caller.

## Why each tool

| Component | Role | Why this one |
|---|---|---|
| **Claude Code** | Builds and maintains the project | The brief's requirement. Every step is a git commit |
| **Vaani Labs** | Answers calls, speaks (including Indian languages and accents) | Built for India. Hinglish shows up in the enquiries (W03, a WhatsApp thread), so callers may mix languages. Per-second billing is documented. **Whether it can drive the conversation turn by turn is unconfirmed**, see below |
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
Caller -> Vaani (voice) -> POST /api/call/turn -> brain
                                                    |-- Gemini reads the facts the caller has stated
                                                    |-- qualification engine decides (plain code)
                                                    |     existing client? -> escalate, never decline
                                                    |     out of scope / out of area / advice only / budget far too low -> decline script
                                                    |     under 6 weeks -> honest "earliest start" (deferral)
                                                    |     unclear -> one follow-up question, then forward with a flag
                                                    |     else qualified
                                                    |-- price question? -> verbatim deflection
                                                    `-- qualified: offer two slots, book in the call
After the call: Telegram handoff + HubSpot deal + call row + cost rows (Supabase)
Dashboard (Vercel) reads the call log.
```

## Testing

`npm test` runs 81 tests. `npm run live:extract` runs the real conversations through live Gemini (needs `GEMINI_API_KEY`). `npm run test:transcripts` prints the T01-T20 table.

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

## Open risk: Vaani

I read Vaani's public docs and OpenAPI spec. They show voice sessions, meeting rooms and API keys, but **no inbound phone-number setup and no way for outside code to control a call turn by turn**. Calls appear to be driven by a dashboard "flow builder", with results delivered as notification-only webhooks (phone numbers masked). Their quickstart also mentions **Twilio** for telephony, a possible extra account and cost. A search result describing a "bring your own LLM" WebSocket was about a different company (Omind's Vaani).

What I built works either way: a stateless "brain" the voice platform calls (`/api/call/start`, `/turn`, `/end`) and a webhook receiver written to Vaani's documented signing and retry rules. What's needed: Vaani confirming that a flow can call an HTTP endpoint on every caller turn. If it can't, the fallback is a platform that accepts a webhook brain, and **that is a stack change I'd raise with you first**.

## Cost

The ledger records every billable event per call. All rates are estimates until confirmed.

- Voice: 4 paise/sec = ₹2.40/min, from Vaani's API page. Their pricing page says pricing is sales-led, so confirm. **Telephony (Twilio) is not included.**
- Gemini: **measured** about ₹0.13 per call (19 real conversations, about 3 model reads each, ₹2.43 in total). Switching off the model's hidden reasoning cut this ~6x; left on, it cost ₹0.80 per single read.
- Cal.com, Telegram, HubSpot, Supabase, Vercel: ₹0 on free tiers.
- A 4-minute call is therefore roughly ₹10 before telephony. If all ~200 monthly enquiries were calls, that is about ₹2,000 a month in usage, plus fixed fees. This is an estimate from documented rates, not a measurement.
- **Unknown or unrecorded costs are never shown as zero.** The dashboard flags the total as incomplete and says why, until fixed fees (number rental, plan fees) are entered.

## Known limitations and what I'd do with more time

- **No real call has happened.** Gemini and the Neon database are verified live; Vaani, Cal.com booking, Telegram messages and HubSpot deals are not. The Gemini check used the 19 calls I tuned against, so it needs a fresh set of calls to mean more.
- **Gemini over-reads "self".** It sometimes marks the caller as the decision-maker when they never said (T02), which skips the flag the designer should see. Worth tightening with real calls.
- **Voice, telephony and the Vaani link** are unresolved (above).
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

## Running it

Requires Node 22.18+ (or 24). No dependencies to install.

```bash
npm test                  # 81 tests
npm run test:transcripts  # T01-T20 table
npm run simulate          # talk to the agent in the terminal (mock services)
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
test/             81 tests
```
