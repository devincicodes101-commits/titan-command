import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { getSupabase } from "@/lib/supabase";
import { decrypt } from "@/lib/crypto";

const AUTH_URL = "https://auth.servicetitan.io/connect/token";
const API_BASE = "https://api.servicetitan.io";

// Today's Opportunities shows 1 but the Dispatch Board has 33 Scheduled + 1
// Dispatched + 3 Working + 8 Hold for today. The board counts whole-job
// jobStatus=Scheduled, which drops multi-visit jobs already in progress. To let
// Reed define the metric, count today's work broken down by status AND business
// unit, deduped by job (so a 7-appointment job counts once). Appointments give
// the "what's on the board today" set; we resolve each to its job to dedupe and
// tag business unit + status.
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
      return { status: res.status, data: body.slice(0, 150) };
    }
  }
  async function pageAll(path: string, cap = 40): Promise<Record<string, unknown>[]> {
    const out: Record<string, unknown>[] = [];
    let page = 1;
    let hasMore = true;
    while (hasMore && page <= cap) {
      const r = await get(`${path}&page=${page}&pageSize=200`);
      const rows = (r.data as { data?: Record<string, unknown>[]; hasMore?: boolean })?.data ?? [];
      out.push(...rows);
      hasMore = Boolean((r.data as { hasMore?: boolean })?.hasMore);
      page++;
    }
    return out;
  }

  // Local (Vancouver) today window.
  const start = "2026-07-16T07:00:00Z";
  const end = "2026-07-17T06:59:59Z";

  // 1. Appointments starting today -> the set of jobs on the board today.
  const appts = await pageAll(
    `/jpm/v2/tenant/${stId}/appointments?startsOnOrAfter=${start}&startsOnOrBefore=${end}`
  );
  const jobIds = [...new Set(appts.map((a) => a.jobId).filter((x): x is number => typeof x === "number"))];

  // 2. Resolve each unique job -> jobStatus + businessUnitId (batched by ids).
  const jobs: Record<string, unknown>[] = [];
  for (let i = 0; i < jobIds.length; i += 50) {
    const chunk = jobIds.slice(i, i + 50).join(",");
    const r = await get(`/jpm/v2/tenant/${stId}/jobs?ids=${chunk}&pageSize=50`);
    jobs.push(...((r.data as { data?: Record<string, unknown>[] })?.data ?? []));
  }

  // 3. Map businessUnitId -> name.
  const buRes = await get(`/settings/v2/tenant/${stId}/business-units?active=true&pageSize=200`);
  const buName = new Map<number, string>();
  for (const bu of ((buRes.data as { data?: { id: number; name: string }[] })?.data ?? [])) {
    buName.set(bu.id, bu.name);
  }

  // 4. Tally deduped jobs by status and by business unit.
  const byStatus: Record<string, number> = {};
  const byBusinessUnit: Record<string, number> = {};
  const byStatusAndBU: Record<string, number> = {};
  for (const j of jobs) {
    const st = String(j.jobStatus ?? "(none)");
    const bu = buName.get(j.businessUnitId as number) ?? `BU:${j.businessUnitId}`;
    byStatus[st] = (byStatus[st] ?? 0) + 1;
    byBusinessUnit[bu] = (byBusinessUnit[bu] ?? 0) + 1;
    const key = `${bu} / ${st}`;
    byStatusAndBU[key] = (byStatusAndBU[key] ?? 0) + 1;
  }

  const activeSet = ["Scheduled", "Dispatched", "InProgress", "Working"];
  const activeNoHold = jobs.filter((j) => activeSet.includes(String(j.jobStatus))).length;
  const activePlusHold = jobs.filter((j) =>
    [...activeSet, "Hold"].includes(String(j.jobStatus))
  ).length;

  return NextResponse.json({
    note: "Deduped by job (multi-visit jobs count once). Show Reed byStatus + byBusinessUnit and ask which statuses/units count. candidateCounts are the likely definitions.",
    appointmentsToday: appts.length,
    uniqueJobsToday: jobIds.length,
    byStatus,
    byBusinessUnit,
    byStatusAndBU,
    candidateCounts: {
      scheduledDispatchedWorking: activeNoHold,
      scheduledDispatchedWorking_plusHold: activePlusHold,
      allJobsOnBoardToday: jobIds.length,
    },
  });
}
