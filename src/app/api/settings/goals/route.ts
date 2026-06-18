import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { auth } from "@/auth";
import { getSupabase } from "@/lib/supabase";

export async function GET() {
  try {
    const session = await auth();
    if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const supabase = getSupabase();
    const [{ data: goals }, { data: units }, { data: tenant }] = await Promise.all([
      supabase.from("tenant_goals").select("*").eq("tenant_id", session.user.tenantId).single(),
      supabase.from("business_units").select("*").eq("tenant_id", session.user.tenantId).order("sort_order"),
      supabase.from("tenants").select("trade").eq("id", session.user.tenantId).single(),
    ]);

    return NextResponse.json({ goals, units, trade: tenant?.trade });
  } catch (err) {
    console.error(err);
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: `Server error: ${message}` }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const session = await auth();
    if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const supabase = getSupabase();
    const { goals, units, trade } = await req.json();
    const now = new Date().toISOString();
    const tid = session.user.tenantId;

    await supabase.from("tenant_goals").upsert({
      tenant_id: tid,
      monthly_revenue_goal: goals.monthlyRevenueGoal,
      monthly_sold_hour_goal: goals.monthlySoldHourGoal,
      weekly_revenue_goal: goals.weeklyRevenueGoal,
      weekly_sold_hour_goal: goals.weeklySoldHourGoal,
      working_days_month: goals.workingDaysMonth,
      updated_at: now,
    }, { onConflict: "tenant_id" });

    await supabase.from("tenants").update({ trade, updated_at: now }).eq("id", tid);

    await supabase.from("business_units").delete().eq("tenant_id", tid);
    await supabase.from("business_units").insert(
      units.map((u: any, i: number) => ({
        id: randomUUID(),
        tenant_id: tid,
        sort_order: i,
        name: u.name,
        target_close_rate: u.targetCloseRate,
        target_rpl: u.targetRpl,
        includes_install: u.includesInstall,
        created_at: now,
        updated_at: now,
      }))
    );

    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error(err);
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: `Server error: ${message}` }, { status: 500 });
  }
}
