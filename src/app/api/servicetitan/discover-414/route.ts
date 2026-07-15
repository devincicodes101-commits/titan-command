import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { getSupabase } from "@/lib/supabase";
import { decrypt } from "@/lib/crypto";

const AUTH_URL = "https://auth.servicetitan.io/connect/token";
const API_BASE = "https://api.servicetitan.io";

// Decisive test. Deriving sold hours ourselves lands ~15-20% below report 414's
// 215.13 on every date basis (invoice 180.25, completion 172.63), so exact parity
// needs 414 read directly. The category LISTING for non-accounting categories
// came back empty, but that never proves a direct GET/RUN of 414 fails — only a
// listing did. So hit report 414 directly across candidate categories: a 200 with
// data means we can read the exact number; a 403 is hard proof the scope is the
// blocker, to hand the client.
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

  const categories = [
    "operations",
    "business-unit-dashboard",
    "technician-dashboard",
    "sold-by",
    "technician",
    "marketing",
    "accounting",
  ];

  const definitionByCategory: Record<string, unknown> = {};
  let goodCategory: string | null = null;
  let goodParams: { name: string; isRequired?: boolean; dataType?: string }[] = [];

  for (const cat of categories) {
    const res = await fetch(
      `${API_BASE}/reporting/v2/tenant/${stId}/report-category/${cat}/reports/414`,
      { headers: authH }
    );
    const body = await res.text();
    let parsed: unknown = body.slice(0, 300);
    try {
      parsed = JSON.parse(body);
    } catch {
      /* keep text */
    }
    definitionByCategory[cat] = { status: res.status, data: res.status === 200 ? parsed : (parsed as { title?: string })?.title ?? parsed };
    if (res.status === 200 && !goodCategory) {
      goodCategory = cat;
      goodParams = ((parsed as { parameters?: { name: string; isRequired?: boolean; dataType?: string }[] })?.parameters) ?? [];
    }
  }

  // If a category served the definition, RUN 414 for Jul 1-15 and read the
  // Item Billable Hours column so we can confirm it equals 215.13.
  let runResult: unknown = "not attempted — no readable category";
  if (goodCategory) {
    const params: { name: string; value: unknown }[] = [];
    for (const p of goodParams) {
      if (p.name === "From") params.push({ name: "From", value: "2026-07-01" });
      else if (p.name === "To") params.push({ name: "To", value: "2026-07-15" });
      else if (p.name === "DateType") params.push({ name: "DateType", value: 0 });
      else if (p.isRequired) params.push({ name: p.name, value: null });
    }
    const res = await fetch(
      `${API_BASE}/reporting/v2/tenant/${stId}/report-category/${goodCategory}/reports/414/data?page=1&pageSize=100`,
      { method: "POST", headers: { ...authH, "Content-Type": "application/json" }, body: JSON.stringify({ parameters: params }) }
    );
    const body = await res.text();
    try {
      runResult = { status: res.status, data: JSON.parse(body) };
    } catch {
      runResult = { status: res.status, data: body.slice(0, 400) };
    }
  }

  return NextResponse.json({
    note: "If any category shows status 200, report 414 IS readable and we can print the exact 215.13. A 403/404 everywhere is proof the Reporting scope is the blocker. runResult includes the report's fields order + rows — find the Item Billable Hours column and confirm 215.13.",
    readableCategory: goodCategory,
    definitionByCategory,
    runResult,
  });
}
