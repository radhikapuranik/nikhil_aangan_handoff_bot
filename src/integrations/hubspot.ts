import type { Crm } from "./types.ts";

// HubSpot CRM v3. Creates a contact, a deal, then links them with the v4
// default-association endpoint (no association type id to get wrong).
// The deal has no amount: the agent never estimates a value.
export class HubSpotCrm implements Crm {
  private token: string;
  private pipeline: string;
  private stage: string;
  private fetchImpl: typeof fetch;

  constructor(token: string, opts: { pipeline?: string; stage?: string } = {}, fetchImpl: typeof fetch = fetch) {
    this.token = token;
    this.pipeline = opts.pipeline ?? "default";
    this.stage = opts.stage ?? "appointmentscheduled"; // default pipeline's first stage; confirm in your account
    this.fetchImpl = fetchImpl;
  }

  private async call(method: string, path: string, body?: unknown) {
    const res = await this.fetchImpl(`https://api.hubapi.com${path}`, {
      method,
      headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) throw new Error(`HubSpot ${method} ${path} -> ${res.status}: ${await res.text()}`);
    return res.json() as Promise<Record<string, unknown>>;
  }

  async createDeal(a: { dealName: string; contactName: string | null; phone: string | null; note: string }) {
    let contactId: string | null = null;
    if (a.phone || a.contactName) {
      try {
        const [first, ...rest] = (a.contactName ?? "Unknown caller").split(" ");
        const c = await this.call("POST", "/crm/v3/objects/contacts", {
          properties: { firstname: first, lastname: rest.join(" ") || undefined, phone: a.phone ?? undefined },
        });
        contactId = String(c.id);
      } catch { /* a missing contact must not lose the deal */ }
    }
    const deal = await this.call("POST", "/crm/v3/objects/deals", {
      properties: { dealname: a.dealName, pipeline: this.pipeline, dealstage: this.stage, description: a.note },
    });
    const dealId = String(deal.id);
    if (contactId) {
      try { await this.call("PUT", `/crm/v4/objects/deals/${dealId}/associations/default/contacts/${contactId}`); }
      catch { /* deal exists; association can be fixed by hand */ }
    }
    return { dealId };
  }
}
