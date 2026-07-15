import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { getSupabase } from "@/lib/supabase";
import { decrypt } from "@/lib/crypto";

const AUTH_URL = "https://auth.servicetitan.io/connect/token";
const API_BASE = "https://api.servicetitan.io";

// ST's estimate report (Sold On, Jul 1-16, HVAC - Sales) shows 7 estimates /
// $71,790.40; the board finds 6 / $66,132.40. The gap is exactly one estimate:
// Brad & Gaby Gordica, $5,658.00. The date-only theory was wrong (fix changed
// nothing), so find that estimate and dump its raw fields to see why our sold
// query misses it — likely a null soldOn, an unexpected status, or a null
// businessUnitName (our grouping skips estimates with no BU).
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

  async function pageAll(query: string) {
    const out: Record<string, unknown>[] = [];
    let page = 1;
    let hasMore = true;
    while (hasMore && page <= 30) {
      const res = await fetch(
        `${API_BASE}/sales/v2/tenant/${stId}/estimates?${query}&pageSize=500&page=${page}`,
        { headers }
      );
      if (!res.ok) return out;
      const j = await res.json();
      out.push(...((j.data as Record<string, unknown>[]) ?? []));
      hasMore = j.hasMore ?? false;
      page++;
    }
    return out;
  }

  const slim = (e: Record<string, unknown>) => ({
    id: e.id,
    name: e.name,
    subtotal: e.subtotal,
    soldOn: e.soldOn ?? null,
    status: (e.status as { name?: string } | null)?.name ?? null,
    businessUnitName: e.businessUnitName ?? null,
    jobId: e.jobId ?? null,
    createdOn: e.createdOn,
    soldBy: (e.soldBy as { name?: string } | null)?.name ?? null,
  });

  // A: everything created since Jun 1 — wide net, no sold filter at all.
  const wide = await pageAll("createdOnOrAfter=2026-06-01T00:00:00Z");
  // B: exactly what the board's sold query now asks for.
  const boardQuery = await pageAll(
    "soldAfter=2026-06-30T23:59:59.000Z&soldBefore=2026-07-17T00:00:00.000Z"
  );

  const boardIds = new Set(boardQuery.map((e) => e.id));

  // The missing estimate should be ~5658.00.
  const near5658 = wide.filter((e) => {
    const v = Number(e.subtotal) || 0;
    return v > 5600 && v < 5700;
  });

  // Any estimate marked Sold that the board's sold query did NOT return.
  const soldButMissed = wide
    .filter((e) => (e.status as { name?: string } | null)?.name === "Sold")
    .filter((e) => !boardIds.has(e.id));

  return NextResponse.json({
    note: "near5658 = the missing estimate; look at its soldOn / status / businessUnitName. soldButMissed = Sold estimates the board's sold query fails to return — the reason should be visible in their fields.",
    counts: {
      wideCreatedSinceJun1: wide.length,
      boardSoldQueryReturned: boardQuery.length,
      soldButMissedCount: soldButMissed.length,
    },
    near5658: near5658.map(slim),
    soldButMissed: soldButMissed.slice(0, 15).map(slim),
    boardSoldQuerySample: boardQuery.slice(0, 10).map(slim),
  });
}
