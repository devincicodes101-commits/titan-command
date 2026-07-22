import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { getSupabase } from "@/lib/supabase";
import { decrypt } from "@/lib/crypto";

const AUTH_URL = "https://auth.servicetitan.io/connect/token";
const API_BASE = "https://api.servicetitan.io";

// Board's Demand Service (= HVAC-Service) MTD Sales = $16,770.06, but ST's
// estimate report (Sold On, Jul 1-22, HVAC-Service) sums $20,553.85 — a ~$3,660
// gap that did NOT exist at Jul 1-16 (both were $8,666.16). No guessing: list
// every Sold HVAC-Service estimate with its soldOn + subtotal + BU so we can see
// exactly which ones the board's window/filter drops. `boardCounts` mirrors the
// board's own logic (local window + status Sold); `allSoldWide` casts a wide net
// so anything the board excludes is visible with the reason.
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
    while (hasMore && page <= 40) {
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

  const isService = (e: Record<string, unknown>) =>
    String(e.businessUnitName ?? "").toLowerCase().includes("service") &&
    !String(e.businessUnitName ?? "").toLowerCase().includes("maintenance");
  const status = (e: Record<string, unknown>) =>
    ((e.status as { name?: string } | null)?.name) ?? null;
  const slim = (e: Record<string, unknown>) => ({
    id: e.id,
    soldOn: e.soldOn ?? null,
    subtotal: e.subtotal,
    status: status(e),
    bu: e.businessUnitName ?? null,
  });
  const round2 = (n: number) => Math.round(n * 100) / 100;

  // Board's window: local Vancouver Jul 1 -> Jul 22 (from getCloseRateByBU).
  const startMs = new Date("2026-07-01T07:00:00Z").getTime();
  const endMs = new Date("2026-07-23T06:59:59Z").getTime();

  // Wide net: everything sold in a generous UTC window around the period.
  const wide = await pageAll(
    "soldAfter=2026-06-25T00:00:00Z&soldBefore=2026-07-24T00:00:00Z"
  );
  const serviceSold = wide.filter((e) => isService(e) && status(e) === "Sold");

  // What the board actually counts: Sold + soldOn inside the LOCAL window.
  const counted: Record<string, unknown>[] = [];
  const droppedOutsideWindow: Record<string, unknown>[] = [];
  for (const e of serviceSold) {
    const t = typeof e.soldOn === "string" ? new Date(e.soldOn as string).getTime() : NaN;
    if (Number.isFinite(t) && t >= startMs && t <= endMs) counted.push(e);
    else droppedOutsideWindow.push(e);
  }

  const sum = (arr: Record<string, unknown>[]) =>
    round2(arr.reduce((s, e) => s + (Number(e.subtotal) || 0), 0));

  return NextResponse.json({
    note: "boardTotal should equal the board's $16,770.06. Compare to ST report $20,553.85. droppedOutsideWindow = Sold Service estimates the board excludes because soldOn falls outside its local Jul1-Jul22 window — check their soldOn timestamps for the reason.",
    boardCount: counted.length,
    boardTotal: sum(counted),
    droppedCount: droppedOutsideWindow.length,
    droppedTotal: sum(droppedOutsideWindow),
    droppedOutsideWindow: droppedOutsideWindow.map(slim),
    countedSample: counted.map(slim).slice(0, 40),
  });
}
