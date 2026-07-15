import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { getSupabase } from "@/lib/supabase";
import { decrypt } from "@/lib/crypto";

const AUTH_URL = "https://auth.servicetitan.io/connect/token";
const API_BASE = "https://api.servicetitan.io";

// Read-only discovery. Two open questions:
//  1. Which report exposes Job/Item Billable Hours (= sold hours, 215.13 for
//     Jul 1-15)? The UI calls it "Sales" at /#/new/reports/414, but 414 was not
//     found in any category's first page — so paginate fully and match by name.
//  2. Are `scheduledOnOrAfter`/`scheduledOnOrBefore` real job filters? Today's
//     Opportunities barely moved when they were added (158 -> 156) despite only 5
//     techs, which is what a SILENTLY IGNORED filter looks like — the same failure
//     mode as the invalid `soldOnOrAfter`. Probe returns totalCount per variant:
//     if the counts don't differ, the filter is doing nothing.
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

  // ---- 1. Find the report carrying billable hours -------------------------
  const cats = await get(`/reporting/v2/tenant/${stId}/report-categories`);
  const catIds: string[] = (
    ((cats.data as { data?: { id?: string }[] })?.data ?? [])
      .map((c) => c.id)
      .filter((c): c is string => typeof c === "string")
  );

  const interesting: { category: string; id: unknown; name: unknown }[] = [];
  const perCategoryCount: Record<string, number> = {};

  for (const cat of catIds) {
    let page = 1;
    let hasMore = true;
    let count = 0;
    while (hasMore && page <= 10) {
      const list = await get(
        `/reporting/v2/tenant/${stId}/report-category/${cat}/reports?page=${page}&pageSize=200`
      );
      const rows = (list.data as { data?: { id?: unknown; name?: unknown }[]; hasMore?: boolean })
        ?.data ?? [];
      count += rows.length;
      for (const r of rows) {
        const name = String(r.name ?? "");
        if (String(r.id) === "414" || /sale|billable|business unit/i.test(name)) {
          interesting.push({ category: cat, id: r.id, name: r.name });
        }
      }
      hasMore = Boolean((list.data as { hasMore?: boolean })?.hasMore);
      page++;
    }
    perCategoryCount[cat] = count;
  }

  // Full definition (fields + parameters) for each candidate.
  const definitions = [];
  for (const hit of interesting.slice(0, 6)) {
    definitions.push({
      category: hit.category,
      id: hit.id,
      name: hit.name,
      definition: await get(
        `/reporting/v2/tenant/${stId}/report-category/${hit.category}/reports/${hit.id}`
      ),
    });
  }

  // ---- 2. Is the jobs scheduled-date filter actually applied? -------------
  const jobs = `/jpm/v2/tenant/${stId}/jobs`;
  const tail = `&jobStatus=Scheduled&pageSize=1&includeTotal=true`;
  const probe = {
    noDateFilter: (await get(`${jobs}?pageSize=1&includeTotal=true&jobStatus=Scheduled`)).data,
    scheduledOnOrAfter_today: (
      await get(`${jobs}?scheduledOnOrAfter=2026-07-15T07:00:00Z${tail}`)
    ).data,
    // A deliberately absurd window. If this still returns the same totalCount as
    // the others, the filter is definitively being ignored.
    scheduledOnOrAfter_year2100: (
      await get(`${jobs}?scheduledOnOrAfter=2100-01-01T00:00:00Z${tail}`)
    ).data,
    // Candidate real parameter names to test against.
    firstAppointmentStartsOnOrAfter_2100: (
      await get(`${jobs}?firstAppointmentStartsOnOrAfter=2100-01-01T00:00:00Z${tail}`)
    ).data,
    appointmentStartsOnOrAfter_2100: (
      await get(`${jobs}?appointmentStartsOnOrAfter=2100-01-01T00:00:00Z${tail}`)
    ).data,
  };

  return NextResponse.json({
    note: "reportCandidates: find the one exposing Job/Item Billable Hours; its `fields` order gives the column index. jobFilterProbe: compare totalCount across variants — if the year-2100 probe matches noDateFilter, that parameter is being silently ignored.",
    reportCandidates: interesting,
    reportsSeenPerCategory: perCategoryCount,
    definitions,
    jobFilterProbe: probe,
  });
}
