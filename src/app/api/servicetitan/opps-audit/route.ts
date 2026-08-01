import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { getSupabase } from "@/lib/supabase";
import { decrypt } from "@/lib/crypto";

const AUTH_URL = "https://auth.servicetitan.io/connect/token";
const API_BASE = "https://api.servicetitan.io";

// Validates job-based MTD Opps (#6) after the startsBefore fix. Uses the CORRECT
// upper-bound param (startsBefore) plus an in-code date filter, and shows TWO
// counts per business unit so the whole-month vs month-to-date choice is visible:
//   monthToDate = appointments 1st -> today   (what the board shows now)
//   wholeMonth  = appointments 1st -> month-end (all of this month's booked jobs)
// HVAC-Install is excluded. Read-only, temporary.
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

  async function get(path: string) {
    const res = await fetch(`${API_BASE}${path}`, { headers });
    const body = await res.text();
    try { return { status: res.status, data: JSON.parse(body) }; } catch { return { status: res.status, data: body.slice(0,150) }; }
  }
  async function pageAll(path: string) {
    const out: Record<string, unknown>[] = [];
    let page = 1, more = true;
    while (more && page <= 40) {
      const r = await get(`${path}&page=${page}&pageSize=500`);
      const rows = (r.data as { data?: Record<string,unknown>[]; hasMore?: boolean })?.data ?? [];
      out.push(...rows); more = Boolean((r.data as { hasMore?: boolean })?.hasMore); page++;
    }
    return out;
  }

  const nowLocal = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Vancouver" }).format(new Date());
  const [y, m, d] = nowLocal.split("-").map(Number);
  const monthStart = Date.UTC(y, m - 1, 1, 7, 0, 0);                 // 1st, 00:00 local
  const todayEnd   = Date.UTC(y, m - 1, d + 1, 7, 0, 0) - 1000;      // today 23:59 local
  const monthEnd   = Date.UTC(y, m, 1, 7, 0, 0) - 1000;             // last day 23:59 local
  const startZ = new Date(monthStart).toISOString();
  const monthEndZ = new Date(monthEnd + 1000).toISOString();        // exclusive upper for startsBefore

  // BU id -> name
  const buRes = await get(`/settings/v2/tenant/${stId}/business-units?active=true&pageSize=200`);
  const buName = new Map<number, string>();
  for (const b of ((buRes.data as { data?: { id: number; name: string }[] })?.data ?? [])) buName.set(b.id, b.name);
  const isInstall = (n: string) => n.toLowerCase().includes("install");

  // Appointments 1st -> month end (correct param + in-code date guard)
  const apptByJob = new Map<number, number>(); // jobId -> earliest start ms this month
  for (const a of await pageAll(`/jpm/v2/tenant/${stId}/appointments?startsOnOrAfter=${startZ}&startsBefore=${monthEndZ}`)) {
    const t = typeof a.start === "string" ? new Date(a.start as string).getTime() : NaN;
    if (typeof a.jobId === "number" && Number.isFinite(t) && t >= monthStart && t <= monthEnd) {
      const prev = apptByJob.get(a.jobId);
      if (prev === undefined || t < prev) apptByJob.set(a.jobId, t);
    }
  }

  // Resolve jobs
  const ids = [...apptByJob.keys()];
  const jobs = new Map<number, { bu: string; status: string; jobNumber: unknown }>();
  for (let i = 0; i < ids.length; i += 50) {
    const r = await get(`/jpm/v2/tenant/${stId}/jobs?ids=${ids.slice(i, i + 50).join(",")}&pageSize=50`);
    for (const j of ((r.data as { data?: Record<string,unknown>[] })?.data ?? [])) {
      jobs.set(j.id as number, { bu: buName.get(j.businessUnitId as number) ?? "", status: String(j.jobStatus ?? ""), jobNumber: j.jobNumber });
    }
  }

  const byBU: Record<string, { wholeMonth: number; byStatus: Record<string, number>; jobs: unknown[] }> = {};
  for (const [jid, j] of jobs) {
    if (!j.bu || isInstall(j.bu)) continue;
    const start = apptByJob.get(jid)!;
    const s = (byBU[j.bu] ??= { wholeMonth: 0, byStatus: {}, jobs: [] });
    s.wholeMonth++;
    s.byStatus[j.status] = (s.byStatus[j.status] ?? 0) + 1;
    s.jobs.push({ jobNumber: j.jobNumber, apptDate: new Date(start).toISOString().slice(0,10), status: j.status });
  }
  // sort each BU's jobs by appointment date for easy calendar comparison
  for (const bu of Object.values(byBU)) {
    (bu.jobs as { apptDate: string }[]).sort((a, b) => a.apptDate.localeCompare(b.apptDate));
  }

  return NextResponse.json({
    note: "wholeMonth = the board's MTD Opps. byStatus breaks it down (e.g. how many Canceled). jobs = the FULL list behind the number, sorted by appointment date, so you can tick each against the calendar. HVAC-Install excluded.",
    today: nowLocal,
    byBusinessUnit: byBU,
  });
}
