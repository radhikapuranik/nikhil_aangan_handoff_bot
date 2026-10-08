# Vaani tools to create

For each tool below: method **POST**, header `Authorization: Bearer <your BRAIN_SHARED_SECRET>`, body type JSON. Replace the base URL with your deployed address.

## qualify_enquiry
- URL: `https://YOUR-DEPLOYMENT.vercel.app/api/tools/qualify`
- Description (paste this): Apply Aangan's qualifying rules to what the caller has said so far. Returns the verdict and the exact words to say or the next question to ask. Call it whenever you learn something new. Always follow what it returns.

| Parameter | Type | Meaning |
|---|---|---|
| `callId` | string | The call's id from the platform, if available. |
| `callerPhone` | string | Caller's phone number if known. |
| `callerName` | string | Caller's name if given. |
| `existingClient` | boolean | true only if they already have a designer or a project under way with Aangan. |
| `serviceType` | string | One of: full_home, partial_home, single_room, commercial_office, restaurant, hotel, retail, gym, architecture_structural, decor_only, furniture_only, vastu_only, unknown. |
| `intent` | string | full_execution (wants design and execution by us), advice_only, or unclear. |
| `location` | string | Where the property is, in the caller's words. |
| `sqft` | integer | Carpet area in square feet, if stated. |
| `rooms` | integer | Number of rooms in scope, if stated. |
| `currentState` | string | Condition of the space: bare shell, lived-in, builder finish, etc. |
| `timelineKind` | string | start_by (execution must start by), complete_by (must be finished or moved into by), flexible, or unknown. |
| `timelineWeeks` | integer | Weeks from today to that date. Whole number. |
| `decisionMaker` | string | self, authorised, family_attending, research_only, or unknown. |
| `decisionMakerNote` | string | Short note, e.g. 'husband agrees' or 'parents will attend'. |
| `budgetMinRupees` | integer | ONLY if the caller volunteered a budget. Whole rupees (1 lakh = 100000). |
| `budgetMaxRupees` | integer | ONLY if the caller volunteered a budget. Whole rupees. |
| `alreadyAsked` | array of strings | Questions you have already asked: any of project, location, timeline, decision_maker. Repeat an item each time you ask it again. |

## check_availability
- URL: `https://YOUR-DEPLOYMENT.vercel.app/api/tools/availability`
- Description (paste this): Get two free consultation slots to offer the caller. Call only after qualify_enquiry says the caller qualifies.

| Parameter | Type | Meaning |
|---|---|---|
| `callId` | string | The call's id, if available. |
| `callerPhone` | string | Caller's phone number if known. |

## book_consultation
- URL: `https://YOUR-DEPLOYMENT.vercel.app/api/tools/book`
- Description (paste this): Book the consultation in the slot the caller chose. Only tell the caller it is booked if this returns confirmed true.

| Parameter | Type | Meaning |
|---|---|---|
| `callId` | string | The call's id, if available. |
| `callerPhone` | string | Caller's phone number. |
| `callerName` | string | Caller's name. |
| `slotStart` | string | The 'start' value of the chosen slot, exactly as returned by check_availability. |

## Webhook
Create a webhook for **call.completed** (and call.failed) pointing at `https://YOUR-DEPLOYMENT.vercel.app/api/webhooks/vaani`. Put the signing secret Vaani shows you (starts `vv_whk_`) in `VAANI_WEBHOOK_SECRET`.
