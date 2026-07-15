import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { getSupabase } from "@/lib/supabase";
import { decrypt } from "@/lib/crypto";

const AUTH_URL = "https://auth.servicetitan.io/connect/token";
const API_BASE = "https://api.servicetitan.io";

// Read-only discovery endpoint. Report 414 ("Sales") is the source of truth for
// Job/Item Billable Hours (= Reed's sold hours). Before wiring it up we need its
// real category, parameter names and column order straight from ServiceTitan —
// deriving sold hours ourselves has been wrong twice (148x over, then 43% under),
// and guessing at ST parameter names 400s the whole refresh.
export async function GET() {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: cred } = await getSupabase()
    .from("crm_credentials")
    .select("st_tenant_id, app_key, client_id, client_secret_encrypted, connected")
    .eq("tenant_id", session.user.tenantId)
    .eq("provider", "servicetitan")
    .single();

  if (!cred?.connected) {
    return NextResponse.json({ error: "ServiceTitan not connected" }, { status: 400 });
  }

  const tokenRes = await fetch(AUTH_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: cred.client_id,
      client_secret: decrypt(cred.client_secret_encrypted),
    }),
  });
  const { access_token } = await tokenRes.json();
  const headers = { Authorization: `Bearer ${access_token}`, "ST-App-Key": cred.app_key };
  const stId = cred.st_tenant_id;

  async function get(path: string) {
    const res = await fetch(`${API_BASE}${path}`, { headers });
    const body = await res.text();
    try {
      return { status: res.status, data: JSON.parse(body) };
    } catch {
      return { status: res.status, data: body };
    }
  }

  // 1. Which categories exist?
  const categories = await get(`/reporting/v2/tenant/${stId}/report-categories`);

  // 2. Which category holds report 414? Search each one's report list.
  const categoryNames: string[] = Array.isArray((categories.data as { data?: unknown[] })?.data)
    ? ((categories.data as { data: { id?: string; name?: string }[] }).data
        .map((c) => c.id ?? c.name)
        .filter((c): c is string => typeof c === "string"))
    : [];

  const hits: { category: string; report: unknown }[] = [];
  for (const cat of categoryNames) {
    const list = await get(
      `/reporting/v2/tenant/${stId}/report-category/${cat}/reports?pageSize=200`
    );
    const reports = (list.data as { data?: { id?: number; name?: string }[] })?.data ?? [];
    const match = reports.find((r) => String(r.id) === "414");
    if (match) hits.push({ category: cat, report: match });
  }

  // 3. Full definition (fields + parameters) for 414 in whichever category it lives.
  const definitions = [];
  for (const hit of hits) {
    definitions.push({
      category: hit.category,
      definition: await get(
        `/reporting/v2/tenant/${stId}/report-category/${hit.category}/reports/414`
      ),
    });
  }

  return NextResponse.json(
    {
      note: "Looking for: the category holding report 414, its `parameters` (names + required), and the `fields` array — the INDEX of 'Job Billable Hours' in `fields` is the column position runReport() must read.",
      categories: categories.data,
      matches: hits,
      definitions,
    },
    { status: 200 }
  );
}
