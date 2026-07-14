import { auth } from "@/auth";
import { getSupabase } from "@/lib/supabase";
import type { STCloseRateByBU } from "@/lib/servicetitan";
import CommandBoard from "@/components/CommandBoard";

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

  const [{ data: goals }, { data: units }, { data: tenant }, { data: stCred }, { data: stCache }] =
    await Promise.all([
      supabase.from("tenant_goals").select("*").eq("tenant_id", tid).single(),
      supabase.from("business_units").select("*").eq("tenant_id", tid).order("sort_order"),
      supabase.from("tenants").select("trade").eq("id", tid).single(),
      supabase
        .from("crm_credentials")
        .select("connected")
        .eq("tenant_id", tid)
        .eq("provider", "servicetitan")
        .single(),
      supabase
        .from("st_cache")
        .select("data, refreshed_at")
        .eq("tenant_id", tid)
        .single(),
    ]);

  const serviceTitanConnected = stCred?.connected ?? false;

  type CacheData = {
    mtdRevenue: number;
    wtdRevenue: number;
    yesterdayRevenue: number;
    callsRan: number;
    closeRateByBU: Record<string, STCloseRateByBU>;
    deptPerformance: Record<string, { revenue: number; jobsCompleted: number } | null>;
    installCrewCount: number;
    mtdSoldHours: number;
    todaysOpportunities: number;
  };

  const cached = stCache?.data as CacheData | null;
  const refreshedAt = stCache?.refreshed_at ?? null;

  const liveRevenue = cached
    ? { mtdRevenue: cached.mtdRevenue, wtdRevenue: cached.wtdRevenue, yesterdayRevenue: cached.yesterdayRevenue }
    : null;

  const liveDeptPerformance = cached?.deptPerformance
    ? {
        Maintenance: cached.deptPerformance.Maintenance ?? { revenue: 0, jobsCompleted: 0 },
        Service: cached.deptPerformance.Service ?? { revenue: 0, jobsCompleted: 0 },
        Installation: cached.deptPerformance.Installation ?? { revenue: 0, jobsCompleted: 0 },
      }
    : null;

  const savedGoals = goals
    ? {
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
      }
    : null;

  return (
    <CommandBoard
      savedGoals={savedGoals}
      serviceTitanConnected={serviceTitanConnected}
      liveRevenue={liveRevenue}
      liveRevenueError={null}
      liveDeptPerformance={liveDeptPerformance}
      liveCallsRan={cached?.callsRan ?? null}
      liveCloseRateByBU={cached?.closeRateByBU ?? null}
      liveInstallCrewCount={cached?.installCrewCount ?? null}
      liveMtdSoldHours={cached?.mtdSoldHours ?? null}
      liveTodaysOpportunities={cached?.todaysOpportunities ?? null}
      refreshedAt={refreshedAt}
    />
  );
}
