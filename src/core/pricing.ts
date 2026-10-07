import { PRICING_DEFLECTION } from "./scripts.ts";

// Hard rule from pricing.md: never state a number, range or per-sq-ft figure.
// Two layers: (1) detect a pricing question and answer with the verbatim
// script; (2) a last-line guard on everything the agent is about to say.

const ASKING_PRICE = [
  /\b(how much|what(?:'s| is| would| will)? (?:the )?(?:cost|price|rate|charge))/i,
  /\b(costs?|prices?|pricing|rates?|charges?|quotes?|quotation|ballpark|estimates?|price list)\b/i,
  /\bper\s*(?:sq\.?\s*ft|square\s*f(?:oo|ee)t|sqft)\b/i,
  /\b(kitna|kitne|kharcha|kharch|daam|bhav)\b/i, // Hindi / Hinglish
  /\bhow expensive\b/i,
  // Follow-ups that never repeat the word "cost": "just a rough range", "even a number".
  /\bballpark\b/i,
  /\brough(ly)?\s+(\w+\s+){0,2}(range|figure|number|idea|estimate|amount|cost|price)\b/i,
  /\b(give|even|just|any|some|tell)\s+(me\s+)?(a\s+|an\s+|any\s+|some\s+)?(range|figure|number|estimate)\b/i,
  /\b(starting|starts?)\s+(price|from|at)\b/i,
  /\bwhat('?s| is) (it|that) (going to|gonna)?\s*(come to|run to|be)\b.*\?/i,
];

// A caller *volunteering* their own budget is not a pricing question.
const VOLUNTEERING_BUDGET =
  /\b(my|our)\s+budget\b|\bbudget\s+(is|of|around|max)/i;

export function isPricingQuestion(utterance: string): boolean {
  if (VOLUNTEERING_BUDGET.test(utterance) && !/\?/.test(utterance)) return false;
  return ASKING_PRICE.some((re) => re.test(utterance));
}

// Anything that looks like a price, range or per-sq-ft rate.
const FORBIDDEN_IN_SPEECH = [
  /(?:₹|\brs\.?|\binr)\s*\d/i,
  /\d[\d,.]*\s*(?:lakh|lac|lakhs|crore|cr)\b/i,
  /\bper\s*(?:sq\.?\s*ft|square\s*f(?:oo|ee)t|sqft)\b/i,
  /\/\s*(?:sq\.?\s*ft|sqft)\b/i,
  /\b(?:it'?ll|it will) cost\b/i,
  /\brates? start\b/i,
  /\btypically\b.*\b(?:₹|rs|lakh)/i,
];

export function violatesPricingRule(speech: string): boolean {
  return FORBIDDEN_IN_SPEECH.some((re) => re.test(speech));
}

// Final gate before text-to-speech. Unsafe text is replaced, never edited.
export function guardSpeech(speech: string): { text: string; replaced: boolean } {
  return violatesPricingRule(speech)
    ? { text: PRICING_DEFLECTION, replaced: true }
    : { text: speech, replaced: false };
}

export function pricingResponse(): string {
  return PRICING_DEFLECTION;
}
