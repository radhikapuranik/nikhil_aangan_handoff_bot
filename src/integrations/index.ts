import { CalComCalendar } from "./calcom.ts";
import { DEFAULT_GEMINI_MODEL, GeminiLlm } from "./gemini.ts";
import { HubSpotCrm } from "./hubspot.ts";
import { MockCalendar, MockCrm, MockLlm, MockNotifier } from "./mock.ts";
import { TelegramNotifier } from "./telegram.ts";
import type { Integrations } from "./types.ts";

type Env = Record<string, string | undefined>;

// Each service switches to the real thing independently, as soon as its own
// keys are present. Anything missing stays mocked, and `mocked` says which.
export function createIntegrations(env: Env = process.env): Integrations & { mocked: string[] } {
  const mocked: string[] = [];
  const llm = env.GEMINI_API_KEY ? new GeminiLlm(env.GEMINI_API_KEY, env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL) : (mocked.push("gemini"), new MockLlm());
  const calendar = env.CALCOM_API_KEY && env.CALCOM_EVENT_TYPE_ID
    ? new CalComCalendar(env.CALCOM_API_KEY, Number(env.CALCOM_EVENT_TYPE_ID), env.CALCOM_EMAIL_FALLBACK)
    : (mocked.push("calcom"), new MockCalendar());
  const notifier = env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_DESIGNER_CHAT_ID
    ? new TelegramNotifier(env.TELEGRAM_BOT_TOKEN, env.TELEGRAM_DESIGNER_CHAT_ID, env.TELEGRAM_SENIOR_CHAT_ID)
    : (mocked.push("telegram"), new MockNotifier());
  const crm = env.HUBSPOT_TOKEN
    ? new HubSpotCrm(env.HUBSPOT_TOKEN, { pipeline: env.HUBSPOT_PIPELINE, stage: env.HUBSPOT_DEAL_STAGE })
    : (mocked.push("hubspot"), new MockCrm());
  return { llm, calendar, notifier, crm, mocked };
}
