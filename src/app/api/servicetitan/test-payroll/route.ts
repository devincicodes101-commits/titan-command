import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { getSupabase } from "@/lib/supabase";
import { decrypt } from "@/lib/crypto";

const AUTH_URL = "https://auth.servicetitan.io/connect/token";
const API_BASE = "https://api.servicetitan.io";

export async function GET() {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const tid = session.user.tenantId;
  const supabase = getSupabase();

  const { data: stCred } = await supabase
    .from("crm_credentials")
    .select("st_tenant_id, app_key, client_id, client_secret_encrypted, connected")
    .eq("tenant_id", tid)
    .eq("provider", "servicetitan")
    .single();

  if (!stCred?.connected) {
    return NextResponse.json({ error: "ServiceTitan not connected" }, { status: 400 });
  }

  const clientSecret = decrypt(stCred.client_secret_encrypted);
  const tokenRes = await fetch(AUTH_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: stCred.client_id,
      client_secret: clientSecret,
    }),
  });
  const { access_token } = await tokenRes.json();

  const headers = {
    Authorization: `Bearer ${access_token}`,
    "ST-App-Key": stCred.app_key,
  };

  const stId = stCred.st_tenant_id;
  const from = "2026-07-01";
  const to = "2026-07-05";

  async function tryEndpoint(label: string, path: string) {
    const res = await fetch(`${API_BASE}${path}`, { headers });
    const body = await res.text();
    let parsed: unknown = body;
    try { parsed = JSON.parse(body); } catch {}
    return { label, status: res.status, data: parsed };
  }

  const results = await Promise.all([
    // Payroll - job splits path variations
    tryEndpoint("jobsplits-v1", `/payroll/v2/tenant/${stId}/jobsplits?from=${from}&to=${to}&pageSize=5`),
    tryEndpoint("job-splits-hyphen", `/payroll/v2/tenant/${stId}/job-splits?from=${from}&to=${to}&pageSize=5`),
    tryEndpoint("payrolls", `/payroll/v2/tenant/${stId}/payrolls?from=${from}&to=${to}&pageSize=5`),
    tryEndpoint("timesheets", `/payroll/v2/tenant/${stId}/timesheets?from=${from}&to=${to}&pageSize=5`),
    tryEndpoint("gross-pay-items", `/payroll/v2/tenant/${stId}/gross-pay-items?from=${from}&to=${to}&pageSize=5`),
    // Reporting categories
    tryEndpoint("report-category-payroll", `/reporting/v2/tenant/${stId}/report-category/payroll/reports`),
    tryEndpoint("report-category-labor", `/reporting/v2/tenant/${stId}/report-category/labor/reports`),
    tryEndpoint("report-category-dispatch", `/reporting/v2/tenant/${stId}/report-category/dispatch/reports`),
  ]);

  return NextResponse.json(results);
}