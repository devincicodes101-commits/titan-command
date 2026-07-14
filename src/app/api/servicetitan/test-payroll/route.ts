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
    // Estimates — check if soldHours field exists on sold estimates
    tryEndpoint("estimates-sold-sample", `/sales/v2/tenant/${stId}/estimates?createdOnOrAfter=${from}T00:00:00Z&pageSize=3`),
    // Dispatch — technician shifts (Techs Available Today)
    tryEndpoint("dispatch-shifts", `/dispatch/v2/tenant/${stId}/shifts?from=${from}&to=${to}&pageSize=5`),
    tryEndpoint("dispatch-teams", `/dispatch/v2/tenant/${stId}/teams?pageSize=5`),
    tryEndpoint("dispatch-technicians", `/dispatch/v2/tenant/${stId}/technicians?pageSize=5`),
    // Schedule — capacity
    tryEndpoint("schedule-availability", `/scheduling/v2/tenant/${stId}/availability?from=${from}&to=${to}&pageSize=5`),
    // Jobs — today's jobs booked (Today's Opportunities)
    tryEndpoint("jobs-today", `/jpm/v2/tenant/${stId}/jobs?createdOnOrAfter=${from}T00:00:00Z&pageSize=5`),
    // Reporting — check if any new categories opened
    tryEndpoint("report-category-dispatch", `/reporting/v2/tenant/${stId}/report-category/dispatch/reports`),
    tryEndpoint("report-category-labor", `/reporting/v2/tenant/${stId}/report-category/labor/reports`),
  ]);

  return NextResponse.json(results);
}