import pg from "pg";
import type { CostEntry } from "../core/costs.ts";
import { emptyCall, type CallRepository } from "./repository.ts";
import type { CallRecord, DateRange, FixedCost, NewCall, StoredCost } from "./types.ts";

// Repository for any Postgres (Neon in production). Same interface as the
// in-memory and Supabase versions.

const snake = (s: string) => s.replace(/[A-Z]/g, (m) => "_" + m.toLowerCase());
const camel = (s: string) => s.replace(/_([a-z])/g, (_, c) => c.toUpperCase());

// Columns stored as jsonb need an explicit cast; node-postgres would
// otherwise send a JS array as a Postgres array.
const JSONB_COLUMNS = new Set(["transcript", "facts", "checks", "session_state"]);

// Return the types the rest of the code expects: ISO strings for timestamps,
// "YYYY-MM-DD" for dates, numbers (not strings) for numeric.
export const typeParsers = {
  getTypeParser(oid: number, format?: "text" | "binary") {
    if (oid === 1184 || oid === 1114) return (v: string) => new Date(v).toISOString(); // timestamptz, timestamp
    if (oid === 1082) return (v: string) => v; // date
    if (oid === 1700) return (v: string) => Number(v); // numeric
    return pg.types.getTypeParser(oid, format as "text");
  },
};

function fromRow<T>(r: Record<string, unknown>): T {
  return Object.fromEntries(Object.entries(r).map(([k, v]) => [camel(k), v])) as T;
}

export interface Queryable { query(sql: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }> }

export class PostgresRepository implements CallRepository {
  private db: Queryable;

  constructor(db: Queryable) { this.db = db; }

  static fromUrl(url: string) {
    return new PostgresRepository(new pg.Pool({ connectionString: url, max: 3, types: typeParsers }));
  }

  private val(col: string, v: unknown) {
    return JSONB_COLUMNS.has(col) && v !== null && v !== undefined ? JSON.stringify(v) : v;
  }

  async createCall(c: NewCall) {
    const rec = emptyCall(c) as unknown as Record<string, unknown>;
    const cols = Object.keys(rec).map(snake);
    const params = Object.entries(rec).map(([k, v]) => this.val(snake(k), v));
    const marks = cols.map((col, i) => (JSONB_COLUMNS.has(col) ? `$${i + 1}::jsonb` : `$${i + 1}`));
    // A retried webhook must not overwrite a finished call: do nothing on conflict, return the existing row.
    const ins = await this.db.query(
      `insert into calls (${cols.join(", ")}) values (${marks.join(", ")}) on conflict (provider_call_id) do nothing returning *`,
      params,
    );
    if (ins.rows.length) return fromRow<CallRecord>(ins.rows[0]);
    const existing = c.providerCallId ? await this.getByProviderCallId(c.providerCallId) : null;
    if (!existing) throw new Error("createCall: insert returned no row and no existing call found");
    return existing;
  }

  async updateCall(id: string, patch: Partial<Omit<CallRecord, "id">>) {
    // undefined means "leave alone", matching the other repositories.
    const entries = Object.entries(patch).filter(([, v]) => v !== undefined);
    if (!entries.length) {
      const cur = await this.db.query("select * from calls where id = $1", [id]);
      if (!cur.rows.length) throw new Error(`call ${id} not found`);
      return fromRow<CallRecord>(cur.rows[0]);
    }
    const sets = entries.map(([k], i) => {
      const col = snake(k);
      return `${col} = $${i + 2}${JSONB_COLUMNS.has(col) ? "::jsonb" : ""}`;
    });
    const res = await this.db.query(`update calls set ${sets.join(", ")} where id = $1 returning *`, [id, ...entries.map(([k, v]) => this.val(snake(k), v))]);
    if (!res.rows.length) throw new Error(`call ${id} not found`);
    return fromRow<CallRecord>(res.rows[0]);
  }

  async getByProviderCallId(pid: string) {
    const r = await this.db.query("select * from calls where provider_call_id = $1 limit 1", [pid]);
    return r.rows.length ? fromRow<CallRecord>(r.rows[0]) : null;
  }

  async addCosts(callId: string, entries: CostEntry[]) {
    for (const e of entries) {
      await this.db.query(
        "insert into call_costs (call_id, service, units, unit, cost_inr, rate_note) values ($1, $2, $3, $4, $5, $6)",
        [callId, e.service, e.units, e.unit, e.costInr, e.rateNote ?? null],
      );
    }
  }

  async listCalls({ from, to }: DateRange) {
    const r = await this.db.query("select * from calls where started_at >= $1 and started_at < $2 order by started_at desc limit 5000", [from, to]);
    return r.rows.map((x) => fromRow<CallRecord>(x));
  }

  async listCosts({ from, to }: DateRange) {
    const r = await this.db.query(
      "select c.* from call_costs c join calls k on k.id = c.call_id where k.started_at >= $1 and k.started_at < $2 limit 20000",
      [from, to],
    );
    return r.rows.map((x) => fromRow<StoredCost>(x));
  }

  async listFixedCosts() {
    const r = await this.db.query("select service, monthly_inr, active_from, active_to from fixed_costs");
    return r.rows.map((x) => fromRow<FixedCost>(x));
  }

  async addFixedCost(f: FixedCost) {
    await this.db.query("insert into fixed_costs (service, monthly_inr, active_from, active_to) values ($1, $2, $3, $4)", [f.service, f.monthlyInr, f.activeFrom, f.activeTo]);
  }

  async recordProviderEvent(e: { id: string; type: string; payload: unknown }) {
    const r = await this.db.query(
      "insert into provider_events (id, type, payload) values ($1, $2, $3::jsonb) on conflict (id) do nothing returning id",
      [e.id, e.type, JSON.stringify(e.payload)],
    );
    return r.rows.length > 0;
  }
}
