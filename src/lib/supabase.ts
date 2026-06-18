import { createClient } from "@supabase/supabase-js";

// Server-side only — uses service key, never expose to browser
export const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_KEY!
);