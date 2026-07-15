import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { getSupabase } from "@/lib/supabase";
import { decrypt } from "@/lib/crypto";

const AUTH_URL = "https://auth.servicetitan.io/connect/token";
const API_BASE = "https://api.servicetitan.io";

// Report 414 is API-blocked, but it says "Metrics are based on estimate sales" —
// and the ESTIMATES API is readable. So reproduce 414 from raw estimates. The
// board's MTD Opps counts every estimate (40 for HVAC-Sales) while 414's Sales
// Opportunity is 19 — hypothesis: 414 counts distinct JOBS (one job w/ 3 options
// = 1 opportunity). This breaks estimates down per BU so we can match each 414
// column to a raw figure and then fix the board to match with no scope change.
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

  async function pageAll(query: string): Promise<Record<string, unknown>[]> {
    const out: Record<string, unknown>[] = [];
    let page = 1;
    let hasMore = true;
    while (hasMore && page <= 50) {
      const res = await fetch(
        `${API_BASE}/sales/v2/tenant/${stId}/estimates?${query}&pageSize=500&page=${page}`,
        { headers }
      );
      if (!res.ok) return out;
      const json = await res.json();
      out.push(...((json.data as Record<string, unknown>[]) ?? []));
      hasMore = json.hasMore ?? false;
      page++;
    }
    return out;
  }

  // Local Jul 1-16 window (Vancouver).
  const created = await pageAll("createdOnOrAfter=2026-07-01T07:00:00Z&createdBefore=2026-07-17T07:00:00Z");
  const sold = await pageAll("soldAfter=2026-07-01T07:00:00Z&soldBefore=2026-07-17T07:00:00Z");

  type Agg = {
    estimateCount: number;
    distinctJobs: Set<number>;
    distinctCustomers: Set<number>;
    statuses: Record<string, number>;
  };
  const createdByBU: Record<string, Agg> = {};
  const bu = (e: Record<string, unknown>) => (e.businessUnitName as string) ?? "(none)";
  const st = (e: Record<string, unknown>) =>
    ((e.status as { name?: string } | null)?.name) ?? "(none)";

  for (const e of created) {
    const k = bu(e);
    const a = (createdByBU[k] ??= {
      estimateCount: 0,
      distinctJobs: new Set(),
      distinctCustomers: new Set(),
      statuses: {},
    });
    a.estimateCount++;
    if (typeof e.jobId === "number") a.distinctJobs.add(e.jobId);
    const cid = (e.customer as { id?: number } | null)?.id ?? (e.customerId as number);
    if (typeof cid === "number") a.distinctCustomers.add(cid);
    a.statuses[st(e)] = (a.statuses[st(e)] ?? 0) + 1;
  }

  const soldByBU: Record<string, { soldCount: number; subtotalSum: number; distinctJobs: Set<number> }> = {};
  for (const e of sold) {
    const k = bu(e);
    const a = (soldByBU[k] ??= { soldCount: 0, subtotalSum: 0, distinctJobs: new Set() });
    a.soldCount++;
    a.subtotalSum += Number(e.subtotal) || 0;
    if (typeof e.jobId === "number") a.distinctJobs.add(e.jobId);
  }

  const round2 = (n: number) => Math.round(n * 100) / 100;
  const out: Record<string, unknown> = {};
  const allBUs = new Set([...Object.keys(createdByBU), ...Object.keys(soldByBU)]);
  for (const k of allBUs) {
    const c = createdByBU[k];
    const s = soldByBU[k];
    out[k] = {
      // compare "estimateCount" vs "distinctJobs" to 414's Sales Opportunity
      estimatesCreated: c?.estimateCount ?? 0,
      distinctJobs_created: c?.distinctJobs.size ?? 0,
      distinctCustomers_created: c?.distinctCustomers.size ?? 0,
      statuses_created: c?.statuses ?? {},
      // compare to 414's Sold Estimates + Total Sales
      soldEstimates: s?.soldCount ?? 0,
      soldSubtotal: round2(s?.subtotalSum ?? 0),
      distinctJobs_sold: s?.distinctJobs.size ?? 0,
    };
  }

  return NextResponse.json({
    note: "Match each 414 column to a figure here. Hypothesis: 414 'Sales Opportunity' == distinctJobs_created (not estimatesCreated). 414 'Sold Estimates' == soldEstimates. 414 'Total Sales' == soldSubtotal (or +tax).",
    window: "Jul 1-16 2026 (Vancouver)",
    byBusinessUnit: out,
  });
}
