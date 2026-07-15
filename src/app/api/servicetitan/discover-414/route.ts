import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { getSupabase } from "@/lib/supabase";
import { decrypt } from "@/lib/crypto";

const AUTH_URL = "https://auth.servicetitan.io/connect/token";
const API_BASE = "https://api.servicetitan.io";

// Two viable sources for job-based sold hours finally surfaced, both inside the
// accounting category we can already read (no new ST scopes needed):
//
//  A. Reports "Sold Hours" (87634674), "Hours" (31940251) and "Invoice Item
//     Detail with Pricebook Information" (3300). The v4 field-scan skipped the
//     first two — they returned no fields, so fetch their definitions directly
//     and find out why (custom reports may need a different call).
//  B. Invoice items carry a `soldHours` field outright. Invoices are job-based,
//     so this counts the ~50 estimate-less jobs that estimates can never see.
//     The one sampled invoice had soldHours: null, but it was a legacy imported
//     record from Jan 2025 — check a RECENT invoice before drawing conclusions.
//
// Every date filter is probed with an absurd bound first: ST silently ignores
// unknown params, so a filter that returns the unfiltered total is a fake.
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
      return { status: res.status, data: body.slice(0, 300) };
    }
  }
  async function count(path: string) {
    const r = await get(path);
    const d = r.data as { totalCount?: number; title?: string };
    return { status: r.status, totalCount: d?.totalCount ?? null, error: d?.title ?? null };
  }

  const inv = `/accounting/v2/tenant/${stId}/invoices`;

  // ---- A. The promising reports, fetched directly -------------------------
  const soldHoursReport = await get(
    `/reporting/v2/tenant/${stId}/report-category/accounting/reports/87634674`
  );
  const hoursReport = await get(
    `/reporting/v2/tenant/${stId}/report-category/accounting/reports/31940251`
  );
  const invoiceItemReport = await get(
    `/reporting/v2/tenant/${stId}/report-category/accounting/reports/3300`
  );

  // ---- B. Which invoice date filter is real? -----------------------------
  const filters = {
    baseline: await count(`${inv}?pageSize=1&includeTotal=true`),
    invoicedOnOrAfter_2100: await count(
      `${inv}?invoicedOnOrAfter=2100-01-01T00:00:00Z&pageSize=1&includeTotal=true`
    ),
    invoiceDateOnOrAfter_2100: await count(
      `${inv}?invoiceDateOnOrAfter=2100-01-01T00:00:00Z&pageSize=1&includeTotal=true`
    ),
    createdOnOrAfter_2100: await count(
      `${inv}?createdOnOrAfter=2100-01-01T00:00:00Z&pageSize=1&includeTotal=true`
    ),
    modifiedOnOrAfter_2100: await count(
      `${inv}?modifiedOnOrAfter=2100-01-01T00:00:00Z&pageSize=1&includeTotal=true`
    ),
  };

  // ---- B2. Do RECENT invoice items actually carry soldHours? --------------
  // Sorted newest-first so we see live data, not a 2025 import with null hours.
  const recent = await get(`${inv}?page=1&pageSize=5&orderBy=invoiceDate&orderByDirection=desc`);
  const recentItems = (
    ((recent.data as { data?: { invoiceDate?: string; items?: unknown[] }[] })?.data ?? []).map(
      (i) => ({
        invoiceDate: i.invoiceDate,
        items: (i.items ?? []).map((it) => {
          const item = it as { skuName?: string; quantity?: string; soldHours?: unknown };
          return { skuName: item.skuName, quantity: item.quantity, soldHours: item.soldHours };
        }),
      })
    )
  );

  return NextResponse.json({
    note: "soldHoursReport/hoursReport/invoiceItemReport: if any returns parameters + fields, we can READ sold hours. invoiceDateFilters: a filter is REAL only if the 2100 probe returns 0. recentInvoiceItems: is soldHours actually populated on live invoices?",
    soldHoursReport,
    hoursReport,
    invoiceItemReport,
    invoiceDateFilters: filters,
    recentInvoiceItems: recentItems,
  });
}
