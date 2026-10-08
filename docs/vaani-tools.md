# Vaani tools to create

For each tool below: method **POST**, header `Authorization: Bearer <your BRAIN_SHARED_SECRET>`, body type JSON. Replace the base URL with your deployed address.

## aangan_desk
- URL: `https://aangan-phone-agent.vercel.app/api/tools/desk`
- Description (paste this): Aangan Studio's rules desk. Use action 'qualify' every time you learn something new about the caller's project: it returns the verdict and the exact words to say or the next question to ask, and you must follow it. After a caller qualifies, use action 'availability' to get two consultation slots, then action 'book' with the slot the caller chose. Only tell the caller a booking is confirmed if the result says confirmed is true.

| Parameter | Type | Meaning |
|---|---|---|
| `action` | string | REQUIRED. One of: qualify, availability, book. |
| `callerPhone` | string | Caller's phone number if known. |
| `callerName` | string | Caller's name if given. |
| `existingClient` | boolean | qualify: true only if they already have a designer or a project under way with Aangan. |
| `serviceType` | string | qualify: one of full_home, partial_home, single_room, commercial_office, restaurant, hotel, retail, gym, architecture_structural, decor_only, furniture_only, vastu_only, unknown. |
| `intent` | string | qualify: full_execution (wants design and execution by us), advice_only, or unclear. |
| `location` | string | qualify: where the property is, in the caller's words. |
| `sqft` | number | qualify: carpet area in square feet, if stated. |
| `rooms` | number | qualify: number of rooms in scope, if stated. |
| `currentState` | string | qualify: condition of the space: bare shell, lived-in, builder finish, etc. |
| `timelineKind` | string | qualify: start_by (execution must start by), complete_by (must be finished or moved into by), flexible, or unknown. |
| `timelineWeeks` | number | qualify: whole weeks from today to that date. |
| `decisionMaker` | string | qualify: self, authorised, family_attending, research_only, or unknown. |
| `decisionMakerNote` | string | qualify: short note, e.g. 'husband agrees' or 'parents will attend'. |
| `budgetMinRupees` | number | qualify: ONLY if the caller volunteered a budget. Whole rupees (1 lakh = 100000). |
| `budgetMaxRupees` | number | qualify: ONLY if the caller volunteered a budget. Whole rupees. |
| `alreadyAsked` | string | qualify: comma-separated questions you have already asked: project, location, timeline, decision_maker. Repeat an item each time you ask it again. |
| `slotStart` | string | book: the 'start' value of the slot the caller chose, exactly as returned by action availability. |

## Webhook
Create a webhook for **call.completed** (and call.failed) pointing at `https://aangan-phone-agent.vercel.app/api/webhooks/vaani`. Put the signing secret Vaani shows you (starts `vv_whk_`) in `VAANI_WEBHOOK_SECRET`.
