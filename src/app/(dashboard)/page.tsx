import { auth } from "@/auth";
import { getSupabase } from "@/lib/supabase";
import { getRevenueSummary } from "@/lib/servicetitan";
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

      const [mtd, wtd, yest] = await Promise.all([
        getRevenueSummary(creds, firstOfMonth, today),
        getRevenueSummary(creds, weekStart, today),
        getRevenueSummary(creds, yesterdayStr, yesterdayStr),
      ]);
      liveRevenue = { mtdRevenue: mtd.total, wtdRevenue: wtd.total, yesterdayRevenue: yest.total };
    } catch (err) {
      console.error("ServiceTitan live revenue fetch failed:", err);
    }
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
    />
  );
}