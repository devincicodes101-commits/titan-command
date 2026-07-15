import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { getSupabase } from "@/lib/supabase";
import { decrypt } from "@/lib/crypto";

const AUTH_URL = "https://auth.servicetitan.io/connect/token";
const API_BASE = "https://api.servicetitan.io";

// Sold hours must come from JOBS, not estimates: report 414 shows 67 completed
// jobs against only 17 sold estimates, so ~50 jobs (75%) were invoiced with no
// estimate at all. Their hours are invisible to an estimate-based calculation —
// which is the whole 126.44 vs 215.13 gap, and no estimate-query fix can close it.
//
// Report 414 itself is unreachable (only the accounting category lists reports).
// But a report can carry a billable-hours COLUMN without saying so in its name,
// and we have 39 accounting reports. So scan every one's `fields` for hours —
// if any exposes them, sold hours can be READ rather than recomputed, with no new
// ST scopes needed. Also checks whether invoice items carry hours directly.
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

  // ---- Scan every accounting report's FIELDS for anything hours-shaped -----
  const list = await get(
    `/reporting/v2/tenant/${stId}/report-category/accounting/reports?page=1&pageSize=200`
  );
  const reports = ((list.data as { data?: { id?: number; name?: string }[] })?.data ?? []);

  const withHours: { id: unknown; name: unknown; hourFields: string[] }[] = [];
  const allReports: { id: unknown; name: unknown }[] = [];

  for (const r of reports) {
    allReports.push({ id: r.id, name: r.name });
    const def = await get(
      `/reporting/v2/tenant/${stId}/report-category/accounting/reports/${r.id}`
    );
    const fields =
      ((def.data as { fields?: { name?: string; label?: string }[] })?.fields ?? []);
    const hourFields = fields
      .filter((f) => /hour|billable/i.test(`${f.name ?? ""} ${f.label ?? ""}`))
      .map((f) => `${f.name} (${f.label})`);
    if (hourFields.length) withHours.push({ id: r.id, name: r.name, hourFields });
  }

  // ---- Do invoice items expose hours directly? ----------------------------
  const invoiceSample = await get(
    `/accounting/v2/tenant/${stId}/invoices?page=1&pageSize=1&includeTotal=true`
  );

  return NextResponse.json({
    note: "reportsExposingHours: any accounting report carrying a billable-hours column — if one exists we can READ sold hours instead of recomputing, with no new ST scopes. invoiceSample: inspect an invoice's items for an hours/skuHours field as a fallback source.",
    reportsExposingHours: withHours,
    accountingReportsScanned: allReports.length,
    allAccountingReports: allReports,
    invoiceSample: invoiceSample.data,
  });
}
