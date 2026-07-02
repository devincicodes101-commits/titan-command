import { auth } from "@/auth";
import { getSupabase } from "@/lib/supabase";
import { getTotalRevenue, getBusinessUnits, getDepartmentPerformance, getCallsRan, getCloseRateByBU, getInstallCrewCount, type STCloseRateByBU } from "@/lib/servicetitan";
import CommandBoard from "@/components/CommandBoard";

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

const TRADE_MAP: Record<string, string> = {
  HVAC: "HVAC", PLUMBING: "Plumbing", ELECTRICAL: "Electrical",
  SOLAR: "Solar", GARAGE_DOORS: "Garage Doors", ROOFING: "Roofing",
  POOLS: "Pools", LANDSCAPE: "Landscape", OTHER: "Other",
};

export default async function DashboardPage() {
  const session = await auth();
  if (!session) return null;

  const tid = session.user.tenantId;
  const supabase = getSupabase();

  const [{ data: goals }, { data: units }, { data: tenant }, { data: stCred }] = await Promise.all([
    supabase.from("tenant_goals").select("*").eq("tenant_id", tid).single(),
    supabase.from("business_units").select("*").eq("tenant_id", tid).order("sort_order"),
    supabase.from("tenants").select("trade").eq("id", tid).single(),
    supabase
      .from("crm_credentials")
      .select("st_tenant_id, app_key, client_id, client_secret_encrypted, connected")
      .eq("tenant_id", tid)
      .eq("provider", "servicetitan")
      .single(),
  ]);

  const serviceTitanConnected = stCred?.connected ?? false;

  let liveRevenue: { mtdRevenue: number; wtdRevenue: number; yesterdayRevenue: number } | null = null;
  let liveRevenueError: string | null = null;
  let liveDeptPerformance: Record<string, { revenue: number; jobsCompleted: number }> | null = null;
  let liveCallsRan: number | null = null;
  let liveCloseRateByBU: Record<string, STCloseRateByBU> | null = null;
  let liveInstallCrewCount: number | null = null;

  if (serviceTitanConnected && stCred) {
    try {
      const creds = {
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

      // Use getTotalRevenue (report 363) for the company-wide figures -- report 3201
      // (used below for the per-department breakdown) silently drops any invoice
      // without a Business Unit assigned, which undercounted real revenue here.
      const [mtdTotal, wtdTotal, yesterdayTotal, businessUnits, callsRan, closeRateByBU] = await Promise.all([
        getTotalRevenue(creds, firstOfMonth, today),
        getTotalRevenue(creds, weekStart, today),
        getTotalRevenue(creds, yesterdayStr, yesterdayStr),
        getBusinessUnits(creds),
        getCallsRan(creds, firstOfMonth, today),
        getCloseRateByBU(creds, firstOfMonth, today),
      ]);
      liveRevenue = { mtdRevenue: mtdTotal, wtdRevenue: wtdTotal, yesterdayRevenue: yesterdayTotal };
      liveCallsRan = callsRan;
      liveCloseRateByBU = closeRateByBU;

      // Map real ServiceTitan business units onto the dashboard's 3 manual-entry
      // department cards by name keyword — works for the "HVAC - X" naming
      // convention seen on Reed's account; may need adjusting for other tenants.
      const findUnit = (keyword: string) =>
        businessUnits.find((u) => u.name.toLowerCase().includes(keyword));
      const maintenanceUnit = findUnit("maintenance");
      const serviceUnit = findUnit("service");
      const installUnit = findUnit("install");
      const deptUnits = [maintenanceUnit, serviceUnit, installUnit].filter(
        (u): u is { id: number; name: string; active: boolean } => Boolean(u)
      );

      if (deptUnits.length > 0) {
        const [perf, crewCount] = await Promise.all([
          getDepartmentPerformance(creds, deptUnits, firstOfMonth, today),
          installUnit ? getInstallCrewCount(creds, installUnit.id) : Promise.resolve(0),
        ]);
        liveDeptPerformance = {};
        if (maintenanceUnit) liveDeptPerformance.Maintenance = perf[maintenanceUnit.name];
        if (serviceUnit) liveDeptPerformance.Service = perf[serviceUnit.name];
        if (installUnit) liveDeptPerformance.Installation = perf[installUnit.name];
        liveInstallCrewCount = crewCount;
      }
    } catch (err) {
      liveRevenueError = err instanceof Error ? err.message : String(err);
      console.error("ServiceTitan live data fetch failed:", liveRevenueError);
    }
  } else if (serviceTitanConnected && !stCred) {
    liveRevenueError = "crm_credentials marked connected but no row was found for this tenant";
  }

  const savedGoals = goals ? {
    monthlyRevenueGoal: goals.monthly_revenue_goal,
    monthlySoldHourGoal: goals.monthly_sold_hour_goal,
    weeklyRevenueGoal: goals.weekly_revenue_goal,
    weeklySoldHourGoal: goals.weekly_sold_hour_goal,
    workingDaysMonth: goals.working_days_month,
    trade: (TRADE_MAP[tenant?.trade ?? "HVAC"] ?? "HVAC") as any,
    businessUnits: (units ?? []).map((u: Record<string, any>) => ({
      name: u.name,
      targetCloseRate: u.target_close_rate,
      targetRpl: u.target_rpl,
      includesInstall: u.includes_install,
    })),
  } : null;

  return (
    <CommandBoard
      savedGoals={savedGoals}
      serviceTitanConnected={serviceTitanConnected}
      liveRevenue={liveRevenue}
      liveRevenueError={liveRevenueError}
      liveDeptPerformance={liveDeptPerformance}
      liveCallsRan={liveCallsRan}
      liveCloseRateByBU={liveCloseRateByBU}
      liveInstallCrewCount={liveInstallCrewCount}
    />
  );
}