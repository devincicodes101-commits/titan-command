import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { getSupabase } from "@/lib/supabase";
import {
  getTotalRevenue,
  getBusinessUnits,
  getDepartmentPerformance,
  getCallsRan,
  getCloseRateByBU,
  getInstallCrewCount,
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

  const now = new Date();
  const today = isoDate(now);
  const firstOfMonth = isoDate(new Date(now.getFullYear(), now.getMonth(), 1));
  const monday = new Date(now);
  monday.setDate(now.getDate() - ((now.getDay() + 6) % 7));
  const weekStart = isoDate(monday);
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  const yesterdayStr = isoDate(yesterday);

  // Revenue calls serialized — firing them in parallel triggers 429 rate limits.
  const mtdRevenue = await getTotalRevenue(creds, firstOfMonth, today);
  const wtdRevenue = await getTotalRevenue(creds, weekStart, today);
  const yesterdayRevenue = await getTotalRevenue(creds, yesterdayStr, yesterdayStr);

  const [businessUnits, callsRan, closeRateByBU] = await Promise.all([
    getBusinessUnits(creds),
    getCallsRan(creds, firstOfMonth, today),
    getCloseRateByBU(creds, firstOfMonth, today),
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

  const mtdSoldHours = Math.round(
    Object.values(closeRateByBU).reduce((sum, bu) => sum + bu.soldHours, 0) * 100
  ) / 100;

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
  };

  await supabase.from("st_cache").upsert(
    { tenant_id: tid, data: cacheData, refreshed_at: new Date().toISOString() },
    { onConflict: "tenant_id" }
  );

  return NextResponse.json({ ok: true, data: cacheData });
}
