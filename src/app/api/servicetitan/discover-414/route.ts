import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { getSupabase } from "@/lib/supabase";
import { decrypt } from "@/lib/crypto";

const AUTH_URL = "https://auth.servicetitan.io/connect/token";
const API_BASE = "https://api.servicetitan.io";

// Board Calls Ran = 97 inbound; ST report "Calls Taken" = 100. Window boundaries
// already match (Jul 1-16 local), so the 3-call gap is likely the DATE FIELD the
// report counts by (receivedOn vs createdOn) or live drift. Probe: which date
// filters are real (year-2100 -> 0), then count nested-inbound under each date
// field and a few window variants to see which totals 100.
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
  const callsBase = `/telecom/v2/tenant/${stId}/calls`;

  async function get(path: string) {
    const res = await fetch(`${API_BASE}${path}`, { headers });
    const body = await res.text();
    try {
      return { status: res.status, data: JSON.parse(body) };
    } catch {
      return { status: res.status, data: body.slice(0, 150) };
    }
  }
  async function totalCount(query: string) {
    const r = await get(`${callsBase}?${query}&pageSize=1&includeTotal=true`);
    return (r.data as { totalCount?: number })?.totalCount ?? null;
  }
  // Page a window and count calls whose nested direction is Inbound.
  async function countInbound(query: string) {
    let inbound = 0;
    let all = 0;
    let page = 1;
    let hasMore = true;
    while (hasMore && page <= 40) {
      const r = await get(`${callsBase}?${query}&page=${page}&pageSize=500`);
      const rows = (r.data as { data?: Record<string, unknown>[]; hasMore?: boolean })?.data ?? [];
      for (const rec of rows) {
        all++;
        const inner =
          (rec.leadCall as { direction?: unknown } | null) ??
          (rec.bookingCall as { direction?: unknown } | null) ??
          (rec as { direction?: unknown });
        if (inner?.direction === "Inbound") inbound++;
      }
      hasMore = Boolean((r.data as { hasMore?: boolean })?.hasMore);
      page++;
    }
    return { inbound, all };
  }

  const start = "2026-07-01T07:00:00Z"; // Jul 1 00:00 local
  const end = "2026-07-17T06:59:59Z"; // Jul 16 23:59 local
  const nowIso = new Date().toISOString();

  return NextResponse.json({
    note: "target = ST 'Calls Taken' 100. Find the variant whose inbound == 100. filterReality: a date filter is real only if year-2100 -> 0.",
    filterReality: {
      createdOnOrAfter_2100: await totalCount("createdOnOrAfter=2100-01-01T00:00:00Z"),
      receivedOnOrAfter_2100: await totalCount("receivedOnOrAfter=2100-01-01T00:00:00Z"),
      modifiedOnOrAfter_2100: await totalCount("modifiedOnOrAfter=2100-01-01T00:00:00Z"),
    },
    counts: {
      byCreatedOn_localWindow: await countInbound(
        `createdOnOrAfter=${start}&createdOnOrBefore=${end}`
      ),
      byReceivedOn_localWindow: await countInbound(
        `receivedOnOrAfter=${start}&receivedOnOrBefore=${end}`
      ),
      byModifiedOn_localWindow: await countInbound(
        `modifiedOnOrAfter=${start}&modifiedOnOrBefore=${end}`
      ),
      byCreatedOn_untilNow: await countInbound(
        `createdOnOrAfter=${start}&createdOnOrBefore=${nowIso}`
      ),
    },
  });
}
