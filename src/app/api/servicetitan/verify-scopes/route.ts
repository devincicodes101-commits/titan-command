import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { getSupabase } from "@/lib/supabase";
import { decrypt } from "@/lib/crypto";

const AUTH_URL = "https://auth.servicetitan.io/connect/token";
const API_BASE = "https://api.servicetitan.io";

// Boss reports all scopes/reports enabled. Previously every non-accounting report
// category returned 403 ("Resource owner validation failed") and report 414 was
// unreachable. Re-test: do the categories list reports now, and can we READ +
// RUN report 414? A 200 with rows means the Sales scoreboard + Sold Hours can be
// read exactly. Temporary — delete once wired up.
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
  const authH = { Authorization: `Bearer ${access_token}`, "ST-App-Key": cred.app_key };
  const stId = cred.st_tenant_id;

  async function get(path: string) {
    const res = await fetch(`${API_BASE}${path}`, { headers: authH });
    const body = await res.text();
    let parsed: unknown = body.slice(0, 200);
    try { parsed = JSON.parse(body); } catch {}
    return { status: res.status, data: parsed };
  }

  const categories = [
    "operations", "business-unit-dashboard", "technician-dashboard",
    "sold-by", "technician", "marketing", "accounting",
  ];

  // 1. Do the categories list reports now? (was 0 for everything but accounting)
  const reportCountByCategory: Record<string, number | string> = {};
  for (const cat of categories) {
    const r = await get(`/reporting/v2/tenant/${stId}/report-category/${cat}/reports?page=1&pageSize=200`);
    reportCountByCategory[cat] =
      r.status === 200 ? ((r.data as { data?: unknown[] })?.data?.length ?? 0) : `status ${r.status}`;
  }

  // 2. Can we read report 414's definition? (find the category that serves it)
  let readableCategory: string | null = null;
  let params: { name: string; isRequired?: boolean }[] = [];
  const defByCat: Record<string, number> = {};
  for (const cat of categories) {
    const r = await get(`/reporting/v2/tenant/${stId}/report-category/${cat}/reports/414`);
    defByCat[cat] = r.status;
    if (r.status === 200 && !readableCategory) {
      readableCategory = cat;
      params = ((r.data as { parameters?: { name: string; isRequired?: boolean }[] })?.parameters) ?? [];
    }
  }

  // 3. If readable, RUN 414 for Jul 1-16 and return fields + first rows.
  let runResult: unknown = "not attempted (414 not readable)";
  if (readableCategory) {
    const p: { name: string; value: unknown }[] = [];
    for (const par of params) {
      if (par.name === "From") p.push({ name: "From", value: "2026-07-01" });
      else if (par.name === "To") p.push({ name: "To", value: "2026-07-16" });
      else if (par.name === "DateType") p.push({ name: "DateType", value: 1 });
    }
    const r = await fetch(
      `${API_BASE}/reporting/v2/tenant/${stId}/report-category/${readableCategory}/reports/414/data?page=1&pageSize=50`,
      { method: "POST", headers: { ...authH, "Content-Type": "application/json" }, body: JSON.stringify({ parameters: p }) }
    );
    const body = await r.text();
    try { runResult = { status: r.status, data: JSON.parse(body) }; }
    catch { runResult = { status: r.status, data: body.slice(0, 300) }; }
  }

  return NextResponse.json({
    note: "If readableCategory is not null, 414 is now readable — we can pull the exact Sales scoreboard + Sold Hours. reportCountByCategory shows which categories opened up.",
    reportCountByCategory,
    report414_definitionStatusByCategory: defByCat,
    readableCategory,
    runResult,
  });
}
