import { readdir, readFile } from "node:fs/promises";
import pg from "pg";

// Applies db/migrations/*.sql in order, once each. Safe to re-run.
const url = process.env.DATABASE_URL;
if (!url) { console.error("DATABASE_URL is not set"); process.exit(1); }
const client = new pg.Client({ connectionString: url });
await client.connect();
await client.query("create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())");
const dir = new URL("../../db/migrations/", import.meta.url);
for (const f of (await readdir(dir)).filter((x) => x.endsWith(".sql")).sort()) {
  const done = await client.query("select 1 from schema_migrations where name = $1", [f]);
  if (done.rows.length) { console.log("skip   ", f); continue; }
  await client.query("begin");
  try {
    await client.query(await readFile(new URL(f, dir), "utf8"));
    await client.query("insert into schema_migrations (name) values ($1)", [f]);
    await client.query("commit");
    console.log("applied", f);
  } catch (e) { await client.query("rollback"); console.error("FAILED ", f, (e as Error).message); process.exit(1); }
}
await client.end();
