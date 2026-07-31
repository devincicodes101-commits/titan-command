import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { getSupabase } from "@/lib/supabase";
import { decrypt } from "@/lib/crypto";

const AUTH_URL = "https://auth.servicetitan.io/connect/token";
const API_BASE = "https://api.servicetitan.io";

// Board's "Calls Ran" = completed jobs this month in the Demand Service +
// Maintenance units (96). The client's report shows 90 invoices for the same
// units. This lists every completed job in those units with whether it carries an
// invoiceId, so the 96 total and the ~6-job gap (completed jobs with no invoice)
// are verified job-by-job instead of assumed. Read-only, temporary.
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
      return { status: res.status, data: body.slice(0, 150) };
    }
  }
  async function pageJobs(query: string) {
    const out: Record<string, unknown>[] = [];
    let page = 1;
    let hasMore = true;
    while (hasMore && page <= 30) {
      const r = await get(`/jpm/v2/tenant/${stId}/jobs?${query}&page=${page}&pageSize=200`);
      const rows = (r.data as { data?: Record<string, unknown>[]; hasMore?: boolean })?.data ?? [];
      out.push(...rows);
      hasMore = Boolean((r.data as { hasMore?: boolean })?.hasMore);
      page++;
    }
    return out;
  }

  // Identify the Demand Service + Maintenance business units by name.
  const buRes = await get(`/settings/v2/tenant/${stId}/business-units?active=true&pageSize=200`);
  const allBUs = ((buRes.data as { data?: { id: number; name: string }[] })?.data ?? []);
  const target = allBUs.filter((b) => {
    const n = b.name.toLowerCase();
    return (n.includes("service") && !n.includes("maintenance")) || n.includes("maintenance");
  });

  // Local (Vancouver) month-to-date window in UTC.
  const nowLocal = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Vancouver" }).format(new Date());
  const firstOfMonth = nowLocal.slice(0, 8) + "01";
  const completedOnOrAfter = `${firstOfMonth}T07:00:00Z`; // Vancouver midnight

  const perUnit: Record<string, { total: number; withInvoice: number; withoutInvoice: number; sampleNoInvoice: unknown[] }> = {};
  for (const bu of target) {
    const jobs = await pageJobs(
      `businessUnitId=${bu.id}&jobStatus=Completed&completedOnOrAfter=${completedOnOrAfter}`
    );
    const withInv = jobs.filter((j) => typeof j.invoiceId === "number");
    const noInv = jobs.filter((j) => typeof j.invoiceId !== "number");
    perUnit[bu.name] = {
      total: jobs.length,
      withInvoice: withInv.length,
      withoutInvoice: noInv.length,
      sampleNoInvoice: noInv.slice(0, 10).map((j) => ({
        jobNumber: j.jobNumber,
        jobStatus: j.jobStatus,
        completedOn: j.completedOn,
        invoiceId: j.invoiceId ?? null,
        total: j.total,
      })),
    };
  }

  const grand = Object.values(perUnit).reduce(
    (a, u) => ({
      total: a.total + u.total,
      withInvoice: a.withInvoice + u.withInvoice,
      withoutInvoice: a.withoutInvoice + u.withoutInvoice,
    }),
    { total: 0, withInvoice: 0, withoutInvoice: 0 }
  );

  return NextResponse.json({
    note: "grandTotal.total = the board's Calls Ran (should be 96). withInvoice ~= the report's invoice count (90). withoutInvoice = the gap; sampleNoInvoice shows those jobs so you can see why (no-charge/warranty/not-yet-billed).",
    unitsCounted: target.map((b) => b.name),
    window: `${firstOfMonth} -> today (Vancouver)`,
    perUnit,
    grandTotal: grand,
  });
}
