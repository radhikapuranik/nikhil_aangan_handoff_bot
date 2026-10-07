import { randomUUID } from "node:crypto";
import type { CostEntry } from "../core/costs.ts";
import { emptyCall, type CallRepository } from "./repository.ts";
import type { CallRecord, DateRange, FixedCost, NewCall, StoredCost } from "./types.ts";

// In-memory repository for tests and for running with no Supabase keys.
export class MemoryRepository implements CallRepository {
  calls = new Map<string, CallRecord>();
  costs: StoredCost[] = [];
  fixed: FixedCost[] = [];
  events = new Map<string, { type: string; payload: unknown }>();

  async createCall(c: NewCall) {
    if (c.providerCallId) {
      const dup = await this.getByProviderCallId(c.providerCallId);
      if (dup) return dup; // webhook retry
    }
    const rec: CallRecord = { id: randomUUID(), ...emptyCall(c) };
    this.calls.set(rec.id, rec);
    return rec;
  }
  async updateCall(id: string, patch: Partial<Omit<CallRecord, "id">>) {
    const cur = this.calls.get(id);
    if (!cur) throw new Error(`call ${id} not found`);
    const defined = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
    const next = { ...cur, ...defined } as CallRecord;
    this.calls.set(id, next);
    return next;
  }
  async getByProviderCallId(pid: string) {
    return [...this.calls.values()].find((c) => c.providerCallId === pid) ?? null;
  }
  async addCosts(callId: string, entries: CostEntry[]) {
    for (const e of entries)
      this.costs.push({ ...e, id: randomUUID(), callId, createdAt: new Date().toISOString() });
  }
  async listCalls({ from, to }: DateRange) {
    return [...this.calls.values()].filter((c) => c.startedAt >= from && c.startedAt < to);
  }
  async listCosts({ from, to }: DateRange) {
    const ids = new Set((await this.listCalls({ from, to })).map((c) => c.id));
    return this.costs.filter((c) => ids.has(c.callId));
  }
  async listFixedCosts() { return this.fixed; }
  async addFixedCost(f: FixedCost) { this.fixed.push(f); }
  async recordProviderEvent(e: { id: string; type: string; payload: unknown }) {
    if (this.events.has(e.id)) return false;
    this.events.set(e.id, { type: e.type, payload: e.payload });
    return true;
  }
}
