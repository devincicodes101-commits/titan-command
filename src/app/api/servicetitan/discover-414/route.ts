import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { getSupabase } from "@/lib/supabase";
import { decrypt } from "@/lib/crypto";

const AUTH_URL = "https://auth.servicetitan.io/connect/token";
const API_BASE = "https://api.servicetitan.io";

// The invoices endpoint has NO completion-date filter (every completed* probe
// returned all 10,785 invoices — silently ignored). But report 414 keys Item
// Billable Hours to job completion, and the JOBS endpoint DOES filter by
// completion date (completedOnOrAfter is already used, and real). Each job also
// carries invoiceId. So: completed jobs in-window -> their invoices -> sum
// soldHours. This probe computes that total to compare against 414's 215.13.
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
  const jobsPath = `/jpm/v2/tenant/${stId}/jobs`;
  const invPath = `/accounting/v2/tenant/${stId}/invoices`;

  async function get(path: string) {
    const res = await fetch(`${API_BASE}${path}`, { headers });
    const body = await res.text();
    try {
      return { status: res.status, data: JSON.parse(body) };
    } catch {
      return { status: res.status, data: body.slice(0, 200) };
    }
  }
  async function jobCount(query: string) {
    const r = await get(`${jobsPath}?${query}&pageSize=1&includeTotal=true`);
    const d = r.data as { totalCount?: number };
    return { status: r.status, totalCount: d?.totalCount ?? null };
  }

  // Local (Vancouver, UTC-7) window for Jul 1-15 2026.
  const winStart = "2026-07-01T07:00:00Z";
  const winEnd = "2026-07-16T06:59:59Z";

  // 1. Are the job completion filters real?
  const filterReality = {
    completedOnOrAfter_2100: await jobCount("completedOnOrAfter=2100-01-01T00:00:00Z"),
    completedBefore_1900: await jobCount("completedBefore=1900-01-01T00:00:00Z"),
    completedOnOrBefore_1900: await jobCount("completedOnOrBefore=1900-01-01T00:00:00Z"),
  };

  // 2. Completed jobs in window -> collect invoiceIds.
  const invoiceIds = new Set<number>();
  let jobsInWindow = 0;
  let page = 1;
  let hasMore = true;
  while (hasMore && page <= 50) {
    const r = await get(
      `${jobsPath}?jobStatus=Completed&completedOnOrAfter=${winStart}&completedBefore=${winEnd}&page=${page}&pageSize=200`
    );
    const rows = (r.data as { data?: { invoiceId?: number }[]; hasMore?: boolean })?.data ?? [];
    for (const j of rows) {
      jobsInWindow++;
      if (typeof j.invoiceId === "number") invoiceIds.add(j.invoiceId);
    }
    hasMore = Boolean((r.data as { hasMore?: boolean })?.hasMore);
    page++;
  }

  // 3. Fetch those invoices (batched by ids) and sum soldHours * qty.
  const ids = [...invoiceIds];
  let soldHours = 0;
  let invoicesFetched = 0;
  for (let i = 0; i < ids.length; i += 50) {
    const chunk = ids.slice(i, i + 50).join(",");
    const r = await get(`${invPath}?ids=${chunk}&pageSize=50`);
    const rows = (r.data as { data?: { items?: { soldHours?: unknown; quantity?: unknown }[] }[] })?.data ?? [];
    for (const iv of rows) {
      invoicesFetched++;
      for (const it of iv.items ?? []) {
        soldHours += (Number(it.soldHours) || 0) * (Number(it.quantity) || 0);
      }
    }
  }

  return NextResponse.json({
    note: "If soldHoursViaCompletedJobs.total == 215.13, ship the jobs->invoices completion-date approach. filterReality: completion filter is real only if the absurd-year probe returns 0.",
    filterReality,
    soldHoursViaCompletedJobs: {
      total: Math.round(soldHours * 100) / 100,
      jobsInWindow,
      invoiceIds: ids.length,
      invoicesFetched,
    },
  });
}
