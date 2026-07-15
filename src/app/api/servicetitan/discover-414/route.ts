import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { getSupabase } from "@/lib/supabase";
import { decrypt } from "@/lib/crypto";

const AUTH_URL = "https://auth.servicetitan.io/connect/token";
const API_BASE = "https://api.servicetitan.io";

// Goal: reproduce ST's Call Center report "Calls Taken" (100 for Jul 1-16) from
// raw Telecom data, since that report's category is scope-blocked (same 403 as
// 414). The board currently counts ALL inbound calls (~113), which is broader.
// So pull the calls, dump a sample's fields, and tally by every categorical field
// — one of those buckets (or a combination) should total 100.
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

  // Local (Vancouver, UTC-7) window: Jul 1 00:00 -> Jul 16 23:59.
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

  // Total inbound (what the board counts today).
  const totalInbound = await get(`${base}&direction=Inbound&pageSize=1&includeTotal=true`);

  // Page all calls in-window (both directions) and tally categorical fields.
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

  // Tally the value of every categorical-looking field, split by direction.
  const tallies: Record<string, Record<string, number>> = {};
  const bump = (field: string, val: unknown) => {
    const key = val === null || val === undefined ? "(null)" : String(val);
    (tallies[field] ??= {})[key] = ((tallies[field] ??= {})[key] ?? 0) + 1;
  };
  for (const c of all) {
    const dir = String(c.direction ?? "?");
    for (const [k, v] of Object.entries(c)) {
      if (v !== null && typeof v === "object") continue; // skip nested objects
      if (["id", "from", "to", "duration", "createdOn", "receivedOn"].includes(k)) continue;
      bump(k, v);
      bump(`${k}__${dir}`, v);
    }
  }

  return NextResponse.json({
    note: "Find the bucket (or combination) that totals 100 = ST 'Calls Taken'. totalInboundCount is what the board shows now. sampleCall shows all available fields. tallies breaks down every categorical field, with __Inbound / __Outbound splits.",
    totalInboundCount: (totalInbound.data as { totalCount?: number })?.totalCount ?? null,
    callsPulled: all.length,
    sampleCall: all[0] ?? null,
    tallies,
  });
}
