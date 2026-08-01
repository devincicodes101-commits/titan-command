import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { getSupabase } from "@/lib/supabase";
import { decrypt } from "@/lib/crypto";

const AUTH_URL = "https://auth.servicetitan.io/connect/token";
const API_BASE = "https://api.servicetitan.io";

// Job #12984 (appointment Nov 17) is being counted in the August opps window,
// which means the appointments endpoint is NOT honoring startsOnOrBefore. This
// probe confirms it: (a) year-1900 upper bound should return 0 if honored;
// (b) count appointments in the Aug window and how many actually start after it
// (the future leak); (c) dump a sample appointment so we know the start field
// name to filter on in code. Read-only.
export async function GET() {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { data: cred } = await getSupabase()
    .from("crm_credentials")
    .select("st_tenant_id, app_key, client_id, client_secret_encrypted, connected")
    .eq("tenant_id", session.user.tenantId).eq("provider", "servicetitan").single();
  if (!cred?.connected) return NextResponse.json({ error: "ServiceTitan not connected" }, { status: 400 });

  const tokenRes = await fetch(AUTH_URL, {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "client_credentials", client_id: cred.client_id, client_secret: decrypt(cred.client_secret_encrypted) }),
  });
  const { access_token } = await tokenRes.json();
  const headers = { Authorization: `Bearer ${access_token}`, "ST-App-Key": cred.app_key };
  const stId = cred.st_tenant_id;
  const appt = `/jpm/v2/tenant/${stId}/appointments`;

  async function get(path: string) {
    const res = await fetch(`${API_BASE}${path}`, { headers });
    const body = await res.text();
    try { return { status: res.status, data: JSON.parse(body) }; } catch { return { status: res.status, data: body.slice(0,150) }; }
  }
  async function count(q: string) {
    const r = await get(`${appt}?${q}&pageSize=1&includeTotal=true`);
    return (r.data as { totalCount?: number })?.totalCount ?? null;
  }

  // The board's current August window
  const startZ = "2026-08-01T07:00:00Z";
  const endZ = "2026-08-03T06:59:59Z";

  // Pull the window the board uses, then see how many appts actually start after it
  const inWindow: Record<string, unknown>[] = [];
  { let page=1, more=true;
    while (more && page<=40) {
      const r = await get(`${appt}?startsOnOrAfter=${startZ}&startsOnOrBefore=${endZ}&page=${page}&pageSize=500`);
      const rows = (r.data as {data?: Record<string,unknown>[]; hasMore?: boolean})?.data ?? [];
      inWindow.push(...rows); more = Boolean((r.data as {hasMore?: boolean})?.hasMore); page++;
    }
  }
  const startField = (a: Record<string, unknown>) => (a.start ?? a.startsOn ?? a.startTime) as string | undefined;
  const afterWindow = inWindow.filter((a) => { const s = startField(a); return typeof s === "string" && s > "2026-08-03"; });

  return NextResponse.json({
    note: "If upperBound_1900 > 0, startsOnOrBefore is IGNORED. leakedAfterWindow = appts returned that actually start after Aug 2 (should be 0 if the filter worked). sampleAppt shows the real start-date field name for the in-code fix.",
    filterHonored: {
      startsOnOrBefore_1900: await count("startsOnOrBefore=1900-01-01T00:00:00Z"),   // 0 if honored
      startsBefore_1900: await count("startsBefore=1900-01-01T00:00:00Z"),           // alt name
      startsOnOrAfter_2100: await count("startsOnOrAfter=2100-01-01T00:00:00Z"),     // 0 if honored
    },
    windowReturned: inWindow.length,
    leakedAfterWindow: afterWindow.length,
    leakedSample: afterWindow.slice(0, 5).map((a) => ({ jobId: a.jobId, start: startField(a) })),
    sampleAppt: inWindow[0] ?? null,
  });
}
