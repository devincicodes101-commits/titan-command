import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { getSupabase } from "@/lib/supabase";
import { decrypt } from "@/lib/crypto";

const AUTH_URL = "https://auth.servicetitan.io/connect/token";
const API_BASE = "https://api.servicetitan.io";

// Sold hours from invoice items landed at 180.25 vs report 414's 215.13. 414
// measures Item Billable Hours by JOB COMPLETION date; the current fix filters by
// invoice date, so a job completed in-window but invoiced earlier is missed.
//
// This probe (a) checks whether the invoices endpoint has a real completion-date
// filter (ST silently ignores unknown params, so year-2100 must return 0) and
// (b) actually SUMS invoice-item soldHours for the current MTD window under each
// candidate basis, so we can see which total equals 215.13 before wiring it in.
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
  const inv = `/accounting/v2/tenant/${stId}/invoices`;

  async function get(path: string) {
    const res = await fetch(`${API_BASE}${path}`, { headers });
    const body = await res.text();
    try {
      return { status: res.status, data: JSON.parse(body) };
    } catch {
      return { status: res.status, data: body.slice(0, 200) };
    }
  }
  async function count(query: string) {
    const r = await get(`${inv}?${query}&pageSize=1&includeTotal=true`);
    const d = r.data as { totalCount?: number; title?: string };
    return { status: r.status, totalCount: d?.totalCount ?? null, error: d?.title ?? null };
  }
  // Page every invoice matching `query` and sum item soldHours * qty.
  async function sumSoldHours(query: string) {
    let total = 0;
    let invoices = 0;
    let page = 1;
    let hasMore = true;
    while (hasMore && page <= 50) {
      const r = await get(`${inv}?${query}&page=${page}&pageSize=200`);
      const rows = (r.data as { data?: { items?: { soldHours?: unknown; quantity?: unknown }[] }[]; hasMore?: boolean })?.data ?? [];
      for (const iv of rows) {
        invoices++;
        for (const it of iv.items ?? []) {
          total += (Number(it.soldHours) || 0) * (Number(it.quantity) || 0);
        }
      }
      hasMore = Boolean((r.data as { hasMore?: boolean })?.hasMore);
      page++;
    }
    return { total: Math.round(total * 100) / 100, invoices };
  }

  const from = "2026-07-01";
  const toExclusive = "2026-07-16"; // completedOnOrBefore is inclusive of the day; use next-day floor where needed

  return NextResponse.json({
    note: "filterReality: a completion-date filter is REAL only if its year-2100 probe returns 0. soldHoursTotals: whichever total equals report 414's 215.13 is the correct basis to ship.",
    filterReality: {
      completedOnOrAfter_2100: await count("completedOnOrAfter=2100-01-01T00:00:00Z"),
      completedOnOrBefore_1900: await count("completedOnOrBefore=1900-01-01T00:00:00Z"),
      jobCompletedOnOrAfter_2100: await count("jobCompletedOnOrAfter=2100-01-01T00:00:00Z"),
    },
    soldHoursTotals: {
      byInvoiceDate_current: await sumSoldHours(
        `invoicedOnOrAfter=${from}T00:00:00Z&invoicedOnOrBefore=${toExclusive}T06:59:59Z`
      ),
      byCompletedDate: await sumSoldHours(
        `completedOnOrAfter=${from}T00:00:00Z&completedOnOrBefore=${toExclusive}T06:59:59Z`
      ),
    },
  });
}
