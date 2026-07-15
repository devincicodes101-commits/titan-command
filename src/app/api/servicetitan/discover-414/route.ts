import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { getSupabase } from "@/lib/supabase";
import { decrypt } from "@/lib/crypto";

const AUTH_URL = "https://auth.servicetitan.io/connect/token";
const API_BASE = "https://api.servicetitan.io";

// v9 showed the real call fields are nested in a `leadCall` object, so the flat
// tally was useless. The sample was callType "Excused" (reason "Hang up"). ST's
// "Calls Taken" (100) almost certainly drops junk types like Excused. Board = 113
// inbound. Tally the NESTED callType/reason/direction to find which types sum to
// exactly 100 — that's the filter to apply so the board matches the report.
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

  const from = "2026-07-01T07:00:00Z";
  const to = "2026-07-17T06:59:59Z";
  const base = `/telecom/v2/tenant/${stId}/calls?createdOnOrAfter=${from}&createdOnOrBefore=${to}`;

  async function get(path: string) {
    const res = await fetch(`${API_BASE}${path}`, { headers });
    const body = await res.text();
    try {
      return { status: res.status, data: JSON.parse(body) };
    } catch {
      return { status: res.status, data: body.slice(0, 200) };
    }
  }

  const all: Record<string, unknown>[] = [];
  let page = 1;
  let hasMore = true;
  while (hasMore && page <= 40) {
    const r = await get(`${base}&page=${page}&pageSize=200`);
    const rows = (r.data as { data?: Record<string, unknown>[]; hasMore?: boolean })?.data ?? [];
    all.push(...rows);
    hasMore = Boolean((r.data as { hasMore?: boolean })?.hasMore);
    page++;
  }

  const inc = (o: Record<string, number>, k: string) => {
    o[k] = (o[k] ?? 0) + 1;
  };
  const byCallType: Record<string, number> = {};
  const byCallTypeInbound: Record<string, number> = {};
  const byReasonInbound: Record<string, number> = {};
  const byDirection: Record<string, number> = {};
  let inbound = 0;

  for (const rec of all) {
    // The call payload lives under leadCall (or bookingCall on booking records).
    const inner =
      (rec.leadCall as Record<string, unknown>) ??
      (rec.bookingCall as Record<string, unknown>) ??
      rec;
    const dir = String(inner.direction ?? "?");
    const callType = String(inner.callType ?? "(none)");
    const reason = ((inner.reason as { name?: string } | null)?.name) ?? "(none)";
    inc(byDirection, dir);
    inc(byCallType, callType);
    if (dir === "Inbound") {
      inbound++;
      inc(byCallTypeInbound, callType);
      inc(byReasonInbound, reason);
    }
  }

  return NextResponse.json({
    note: "inbound total should be 113. Find which callType(s) among inbound sum to 100 = ST 'Calls Taken'. e.g. if Excused=13, then all-inbound-minus-Excused = 100.",
    totalRecords: all.length,
    inboundTotal: inbound,
    byDirection,
    byCallTypeInbound,
    byReasonInbound,
    byCallTypeAllDirections: byCallType,
  });
}
