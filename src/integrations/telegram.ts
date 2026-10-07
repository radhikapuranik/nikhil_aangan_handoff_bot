import type { Notifier } from "./types.ts";

// Telegram Bot API. Plain text on purpose: no parse_mode, so caller-supplied
// text can never break the message or inject formatting.
export class TelegramNotifier implements Notifier {
  private token: string;
  private chats: { designers: string; senior: string };
  private fetchImpl: typeof fetch;

  constructor(token: string, designersChatId: string, seniorChatId: string | undefined, fetchImpl: typeof fetch = fetch) {
    this.token = token;
    this.chats = { designers: designersChatId, senior: seniorChatId || designersChatId };
    this.fetchImpl = fetchImpl;
  }

  async send(channel: "designers" | "senior", text: string) {
    const res = await this.fetchImpl(`https://api.telegram.org/bot${this.token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: this.chats[channel], text, disable_web_page_preview: true }),
    });
    const body = (await res.json()) as { ok: boolean; result?: { message_id: number }; description?: string };
    if (!res.ok || !body.ok) throw new Error(`Telegram sendMessage failed: ${res.status} ${body.description ?? ""}`);
    return { messageId: String(body.result!.message_id) };
  }
}
