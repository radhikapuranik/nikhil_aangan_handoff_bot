import type { Calendar, Slot } from "./types.ts";

const TZ = "Asia/Kolkata";

export function slotLabel(startIso: string): string {
  return new Date(startIso).toLocaleString("en-IN", {
    weekday: "long", day: "numeric", month: "long", hour: "numeric", minute: "2-digit", hour12: true, timeZone: TZ,
  });
}

// Cal.com API v2.
// Booking request shape: verified against cal.com/docs (cal-api-version 2026-02-25).
// UNVERIFIED: the slots endpoint (couldn't load its docs page). Both calls
// fail loudly so the session falls back to "the designer will call to confirm".
export class CalComCalendar implements Calendar {
  private apiKey: string;
  private eventTypeId: number;
  private emailFallback: string;
  private fetchImpl: typeof fetch;

  constructor(apiKey: string, eventTypeId: number, emailFallback = "", fetchImpl: typeof fetch = fetch) {
    this.apiKey = apiKey;
    this.eventTypeId = eventTypeId;
    this.emailFallback = emailFallback;
    this.fetchImpl = fetchImpl;
  }

  private async fetchSlots(from: Date, to: Date): Promise<string[]> {
    const qs = new URLSearchParams({ eventTypeId: String(this.eventTypeId), start: from.toISOString(), end: to.toISOString(), timeZone: TZ });
    const res = await this.fetchImpl(`https://api.cal.com/v2/slots?${qs}`, {
      headers: { Authorization: `Bearer ${this.apiKey}`, "cal-api-version": "2024-09-04" },
    });
    if (!res.ok) throw new Error(`Cal.com slots -> ${res.status}: ${await res.text()}`);
    const body = (await res.json()) as { data?: Record<string, { start: string }[]> };
    return Object.values(body.data ?? {}).flat().map((s) => s.start).sort();
  }

  async slotsBetween(from: Date, to: Date): Promise<Slot[]> {
    return (await this.fetchSlots(from, to)).map((start) => ({ start, label: slotLabel(start) }));
  }

  async findSlots(count: number, after: Date): Promise<Slot[]> {
    const all = await this.fetchSlots(after, new Date(after.getTime() + 10 * 86400000));
    // Spread offers over different days so the caller has a real choice.
    const picked: string[] = [];
    for (const s of all) {
      if (picked.length >= count) break;
      if (!picked.length || s.slice(0, 10) !== picked[picked.length - 1].slice(0, 10)) picked.push(s);
    }
    return picked.map((start) => ({ start, label: slotLabel(start) }));
  }

  async book(a: { slot: Slot; name: string | null; phone: string | null; notes: string }) {
    // Cal.com requires an attendee email and checks that its domain can receive
    // mail (a made-up domain is rejected). Callers on a phone line rarely give
    // one, so use a "+" alias of a real studio inbox, e.g. studio+{phone}@domain.
    if (!this.emailFallback.includes("@")) throw new Error("CALCOM_EMAIL_FALLBACK is not set (needs a real inbox, e.g. studio+{phone}@yourdomain.com)");
    const digits = (a.phone ?? "unknown").replace(/\D/g, "") || "unknown";
    const res = await this.fetchImpl("https://api.cal.com/v2/bookings", {
      method: "POST",
      headers: { Authorization: `Bearer ${this.apiKey}`, "cal-api-version": "2026-02-25", "Content-Type": "application/json" },
      body: JSON.stringify({
        start: a.slot.start,
        eventTypeId: this.eventTypeId,
        attendee: {
          name: a.name ?? "Caller",
          email: this.emailFallback.replace("{phone}", digits),
          timeZone: TZ,
          ...(a.phone ? { phoneNumber: a.phone } : {}),
        },
        bookingFieldsResponses: { notes: a.notes },
      }),
    });
    if (!res.ok) throw new Error(`Cal.com booking -> ${res.status}: ${await res.text()}`);
    const body = (await res.json()) as { data: { uid: string; start: string } };
    return { ref: body.data.uid, start: body.data.start };
  }
}
