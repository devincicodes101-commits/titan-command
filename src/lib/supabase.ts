import { createClient, SupabaseClient } from "@supabase/supabase-js";

let client: SupabaseClient | null = null;

export function getSupabase(): SupabaseClient {
  if (client) return client;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url) throw new Error("Missing env var: NEXT_PUBLIC_SUPABASE_URL is not set on this deployment");
  if (!key) throw new Error("Missing env var: SUPABASE_SERVICE_KEY is not set on this deployment");
  client = createClient(url, key);
  return client;
}
