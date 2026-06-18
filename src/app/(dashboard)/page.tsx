import { auth } from "@/auth";
import { getSupabase } from "@/lib/supabase";
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

  const [{ data: goals }, { data: units }, { data: tenant }] = await Promise.all([
    supabase.from("tenant_goals").select("*").eq("tenant_id", tid).single(),
    supabase.from("business_units").select("*").eq("tenant_id", tid).order("sort_order"),
    supabase.from("tenants").select("trade").eq("id", tid).single(),
  ]);

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

  return <CommandBoard savedGoals={savedGoals} />;
}