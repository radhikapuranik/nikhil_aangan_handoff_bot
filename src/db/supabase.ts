import type { CostEntry } from "../core/costs.ts";
import { emptyCall, type CallRepository } from "./repository.ts";
import type { CallRecord, DateRange, FixedCost, NewCall, StoredCost } from "./types.ts";

// Supabase via its PostgREST HTTP API (no SDK dependency). Uses the
// service-role key, so it must only ever run server-side.

const snake = (s: string) => s.replace(/[A-Z]/g, (m) => "_" + m.toLowerCase());
const camel = (s: string) => s.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
const mapKeys = (o: Record<string, unknown>, fn: (k: string) => string) =>
  Object.fromEntries(Object.entries(o).map(([k, v]) => [fn(k), v]));

const toRow = (c: object) => mapKeys(c as Record<string, unknown>, snake);
const fromRow = <T>(r: Record<string, unknown>) => mapKeys(r, camel) as T;

export class SupabaseRepository implements CallRepository {
  private url: string;
  private serviceKey: string;
  private fetchImpl: typeof fetch;

  constructor(url: string, serviceKey: string, fetchImpl: typeof fetch = fetch) {
    this.url = url;
    this.serviceKey = serviceKey;
    this.fetchImpl = fetchImpl;
  }

  private async req(path: string, init: RequestInit & { prefer?: string } = {}) {
    const res = await this.fetchImpl(`${this.url}/rest/v1/${path}`, {
      ...init,
      headers: {
        apikey: this.serviceKey,
        Authorization: `Bearer ${this.serviceKey}`,
        "Content-Type": "application/json",
        ...(init.prefer ? { Prefer: init.prefer } : {}),
      },
    });
    if (!res.ok) throw new Error(`Supabase ${init.method ?? "GET"} ${path} -> ${res.status}: ${await res.text()}`);
    return res.status === 204 ? null : res.json();
  }

  async createCall(c: NewCall) {
    const body = toRow(emptyCall(c));
    // provider_call_id is unique. A retried webhook must NOT overwrite a
    // finished call, so ignore the duplicate and return the existing row.
    const rows = (await this.req("calls?on_conflict=provider_call_id", {
      method: "POST", body: JSON.stringify(body),
      prefer: "resolution=ignore-duplicates,return=representation",
    })) as Record<string, unknown>[];
    if (rows.length) return fromRow<CallRecord>(rows[0]);
    const existing = c.providerCallId ? await this.getByProviderCallId(c.providerCallId) : null;
    if (!existing) throw new Error("createCall: insert returned no row and no existing call found");
    return existing;
  }

  async updateCall(id: string, patch: Partial<Omit<CallRecord, "id">>) {
    const rows = (await this.req(`calls?id=eq.${encodeURIComponent(id)}`, {
      method: "PATCH", body: JSON.stringify(toRow(patch)), prefer: "return=representation",
    })) as Record<string, unknown>[];
    if (!rows.length) throw new Error(`call ${id} not found`);
    return fromRow<CallRecord>(rows[0]);
  }

  async getByProviderCallId(pid: string) {
    const rows = (await this.req(`calls?provider_call_id=eq.${encodeURIComponent(pid)}&limit=1`)) as Record<string, unknown>[];
    return rows.length ? fromRow<CallRecord>(rows[0]) : null;
  }

  async addCosts(callId: string, entries: CostEntry[]) {
    if (!entries.length) return;
    await this.req("call_costs", {
      method: "POST",
      body: JSON.stringify(entries.map((e) => toRow({ callId, ...e }))),
      prefer: "return=minimal",
    });
  }

  async listCalls({ from, to }: DateRange) {
    const rows = (await this.req(`calls?started_at=gte.${encodeURIComponent(from)}&started_at=lt.${encodeURIComponent(to)}&order=started_at.desc&limit=5000`)) as Record<string, unknown>[];
    return rows.map((r) => fromRow<CallRecord>(r));
  }

  async listCosts({ from, to }: DateRange) {
    // Costs belong to calls in the range, via an embedded filter.
    const rows = (await this.req(`call_costs?select=*,calls!inner(started_at)&calls.started_at=gte.${encodeURIComponent(from)}&calls.started_at=lt.${encodeURIComponent(to)}&limit=20000`)) as Record<string, unknown>[];
    return rows.map((r) => { const { calls: _c, ...rest } = r; return fromRow<StoredCost>(rest); });
  }

  async listFixedCosts() {
    const rows = (await this.req("fixed_costs?select=*")) as Record<string, unknown>[];
    return rows.map((r) => fromRow<FixedCost>(r));
  }
}
