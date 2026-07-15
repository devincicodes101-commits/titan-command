import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { getSupabase } from "@/lib/supabase";
import {
  getTotalRevenue,
  getBusinessUnits,
  getDepartmentPerformance,
  getCallsRan,
  getSoldHours,
  getCloseRateByBU,
  getInstallCrewCount,
  getTodaysOpportunities,
  type STCredentials,
} from "@/lib/servicetitan";

function isoDate(d: Date) {
  return d.toISOString().slice(0, 10);
}

export async function POST() {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const tid = session.user.tenantId;
  const supabase = getSupabase();

  const { data: stCred } = await supabase
    .from("crm_credentials")
    .select("st_tenant_id, app_key, client_id, client_secret_encrypted, connected")
    .eq("tenant_id", tid)
    .eq("provider", "servicetitan")
    .single();

  if (!stCred?.connected) {
    return NextResponse.json({ error: "ServiceTitan not connected" }, { status: 400 });
  }

  const creds: STCredentials = {
    stTenantId: stCred.st_tenant_id,
    appKey: stCred.app_key,
    clientId: stCred.client_id,
    clientSecretEncrypted: stCred.client_secret_encrypted,
  };

  // Date boundaries in the tenant's LOCAL calendar (America/Vancouver), not UTC.
  // Vercel runs in UTC, so isoDate(new Date()) rolls to tomorrow every evening in
  // Vancouver (>=5pm PDT is next-day UTC) — which pushed "today" onto tomorrow's
  // board and shifted Yesterday Revenue and the week boundary. Anchor date math to
  // the local calendar date instead.
  const todayLocal = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Vancouver" }).format(
    new Date()
  );
  const [vy, vm, vd] = todayLocal.split("-").map(Number);
  const anchor = new Date(Date.UTC(vy, vm - 1, vd)); // UTC-midnight anchor for date math only
  const today = todayLocal;
  const firstOfMonth = `${vy}-${String(vm).padStart(2, "0")}-01`;
  const monday = new Date(anchor);
  monday.setUTCDate(anchor.getUTCDate() - ((anchor.getUTCDay() + 6) % 7));
  const weekStart = isoDate(monday);
  const yesterday = new Date(anchor);
  yesterday.setUTCDate(anchor.getUTCDate() - 1);
  const yesterdayStr = isoDate(yesterday);

  // Revenue calls serialized — firing them in parallel triggers 429 rate limits.
  const mtdRevenue = await getTotalRevenue(creds, firstOfMonth, today);
  const wtdRevenue = await getTotalRevenue(creds, weekStart, today);
  const yesterdayRevenue = await getTotalRevenue(creds, yesterdayStr, yesterdayStr);

  const [businessUnits, callsRan, closeRateByBU, todaysOpportunities] = await Promise.all([
    getBusinessUnits(creds),
    getCallsRan(creds, firstOfMonth, today),
    getCloseRateByBU(creds, firstOfMonth, today),
    getTodaysOpportunities(creds, today),
  ]);

  const findUnit = (keyword: string) =>
    businessUnits.find((u) => u.name.toLowerCase().includes(keyword));
  const maintenanceUnit = findUnit("maintenance");
  const serviceUnit = findUnit("service");
  const installUnit = findUnit("install");
  const deptUnits = [maintenanceUnit, serviceUnit, installUnit].filter(
    (u): u is { id: number; name: string; active: boolean } => Boolean(u)
  );

  let deptPerformance = {};
  let installCrewCount = 0;
  if (deptUnits.length > 0) {
    const [perf, crewCount] = await Promise.all([
      getDepartmentPerformance(creds, deptUnits, firstOfMonth, today),
      installUnit ? getInstallCrewCount(creds, installUnit.id) : Promise.resolve(0),
    ]);
    deptPerformance = {
      Maintenance: maintenanceUnit ? perf[maintenanceUnit.name] : null,
      Service: serviceUnit ? perf[serviceUnit.name] : null,
      Installation: installUnit ? perf[installUnit.name] : null,
    };
    installCrewCount = crewCount;
  }

  // Sold hours read from invoice items (job-based) rather than summed off
  // estimates — 75% of jobs have no estimate, so the estimate sum ran ~40% low.
  const mtdSoldHours = await getSoldHours(creds, firstOfMonth, today);

  const cacheData = {
    mtdRevenue,
    wtdRevenue,
    yesterdayRevenue,
    callsRan,
    closeRateByBU,
    deptPerformance,
    installCrewCount,
    businessUnits,
    mtdSoldHours,
    todaysOpportunities,
  };

  await supabase.from("st_cache").upsert(
    { tenant_id: tid, data: cacheData, refreshed_at: new Date().toISOString() },
    { onConflict: "tenant_id" }
  );

  return NextResponse.json({ ok: true, data: cacheData });
}
