import type { CallRepository } from "./repository.ts";
import { MemoryRepository } from "./memory.ts";
import { PostgresRepository } from "./postgres.ts";
import { SupabaseRepository } from "./supabase.ts";

// Neon/Postgres if DATABASE_URL is set, else Supabase's HTTP API if its keys
// are set, else in-memory (mock mode).
export function createRepository(env: Record<string, string | undefined> = process.env): CallRepository {
  if (env.DATABASE_URL) return PostgresRepository.fromUrl(env.DATABASE_URL);
  const url = env.SUPABASE_URL, key = env.SUPABASE_SERVICE_ROLE_KEY;
  return url && key ? new SupabaseRepository(url, key) : new MemoryRepository();
}

export const hasDatabase = (env: Record<string, string | undefined>) =>
  Boolean(env.DATABASE_URL || (env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY));
