import type { CallRepository } from "./repository.ts";
import { MemoryRepository } from "./memory.ts";
import { SupabaseRepository } from "./supabase.ts";

// Real Supabase when both env vars are set, otherwise in-memory (mock mode).
export function createRepository(env: Record<string, string | undefined> = process.env): CallRepository {
  const url = env.SUPABASE_URL, key = env.SUPABASE_SERVICE_ROLE_KEY;
  return url && key ? new SupabaseRepository(url, key) : new MemoryRepository();
}
