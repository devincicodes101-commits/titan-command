import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { getSupabase } from "@/lib/supabase";
import { decrypt } from "@/lib/crypto";

const AUTH_URL = "https://auth.servicetitan.io/connect/token";
const API_BASE = "https://api.servicetitan.io";

// Validates the job-based MTD Opps (#6) and Actual Close % (#8) by listing the
// jobs behind each number per business unit — so they can be spot-checked in ST
// job-by-job (there is no single ST report that produces these). Read-only.
//   Opps  = jobs with an appointment this month, excluding HVAC-Install
//   Won   = those jobs that carry a Sold estimate
//   Open  = still Scheduled / In-Progress with no outcome (excluded from close %)
//   Close % = Won / (Opps - Open)
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
    try { return { status: res.status, data: JSON.parse(body) }; }
    catch { return { status: res.status, data: body.slice(0, 150) }; }
  }
  async function pageAll(path: string) {
    const out: Record<string, unknown>[] = [];
    let page = 1, hasMore = true;
    while (hasMore && page <= 40) {
      const r = await get(`${path}&page=${page}&pageSize=500`);
      const rows = (r.data as { data?: Record<string, unknown>[]; hasMore?: boolean })?.data ?? [];
      out.push(...rows);
      hasMore = Boolean((r.data as { hasMore?: boolean })?.hasMore);
      page++;
    }
    return out;
  }

  // Local (Vancouver) month-to-date window.
  const nowLocal = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Vancouver" }).format(new Date());
  const first = nowLocal.slice(0, 8) + "01";
  const startZ = `${first}T07:00:00Z`;
  const [ny, nm, nd] = nowLocal.split("-").map(Number);
  const endZ = new Date(Date.UTC(ny, nm - 1, nd + 1, 7, 0, 0) - 1000).toISOString(); // end of today, local

  // BU id -> name
  const buRes = await get(`/settings/v2/tenant/${stId}/business-units?active=true&pageSize=200`);
  const buName = new Map<number, string>();
  for (const b of ((buRes.data as { data?: { id: number; name: string }[] })?.data ?? [])) buName.set(b.id, b.name);
  const isInstall = (n: string) => n.toLowerCase().includes("install");

  // Appointments this month -> unique jobIds
  const jobIds = new Set<number>();
  for (const a of await pageAll(`/jpm/v2/tenant/${stId}/appointments?startsOnOrAfter=${startZ}&startsOnOrBefore=${endZ}`)) {
    if (typeof a.jobId === "number") jobIds.add(a.jobId);
  }

  // Resolve jobs
  const jobs = new Map<number, { bu: string; status: string; jobNumber: unknown }>();
  const ids = [...jobIds];
  for (let i = 0; i < ids.length; i += 50) {
    const r = await get(`/jpm/v2/tenant/${stId}/jobs?ids=${ids.slice(i, i + 50).join(",")}&pageSize=50`);
    for (const j of ((r.data as { data?: Record<string, unknown>[] })?.data ?? [])) {
      jobs.set(j.id as number, { bu: buName.get(j.businessUnitId as number) ?? "", status: String(j.jobStatus ?? ""), jobNumber: j.jobNumber });
    }
  }

  // Jobs with a Sold estimate (created or sold this month)
  const soldJobIds = new Set<number>();
  const created = await pageAll(`/sales/v2/tenant/${stId}/estimates?createdOnOrAfter=${startZ}`);
  const sold = await pageAll(`/sales/v2/tenant/${stId}/estimates?soldAfter=${startZ}&soldBefore=${endZ}`);
  for (const e of [...created, ...sold]) {
    if ((e.status as { name?: string } | null)?.name === "Sold" && typeof e.jobId === "number") soldJobIds.add(e.jobId);
  }

  // Per-BU breakdown
  const byBU: Record<string, { opps: number; won: number; open: number; sample: unknown[] }> = {};
  for (const [jid, j] of jobs) {
    if (!j.bu || isInstall(j.bu)) continue;
    const s = (byBU[j.bu] ??= { opps: 0, won: 0, open: 0, sample: [] });
    s.opps++;
    const won = soldJobIds.has(jid);
    const open = !won && (j.status === "Scheduled" || j.status === "InProgress");
    if (won) s.won++;
    else if (open) s.open++;
    if (s.sample.length < 8) s.sample.push({ jobNumber: j.jobNumber, status: j.status, won, excludedAsOpen: open });
  }

  const out: Record<string, unknown> = {};
  for (const [bu, s] of Object.entries(byBU)) {
    const closeable = s.opps - s.open;
    out[bu] = {
      mtdOpps: s.opps,
      won: s.won,
      stillOpenExcluded: s.open,
      closeableJobs: closeable,
      actualClosePct: closeable > 0 ? Math.round((s.won / closeable) * 1000) / 10 : 0,
      sampleJobs: s.sample,
    };
  }

  return NextResponse.json({
    note: "Per business unit: mtdOpps (#6) = jobs with an appointment this month (Install excluded). actualClosePct (#8) = won / (opps - stillOpenExcluded). Open a sampleJobs jobNumber in ServiceTitan to spot-check its appointment date, BU and whether it has a sold estimate.",
    window: `${first} -> today (Vancouver)`,
    byBusinessUnit: out,
  });
}
