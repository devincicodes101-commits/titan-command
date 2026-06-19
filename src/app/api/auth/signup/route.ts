import { NextRequest, NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { randomUUID } from "crypto";
import { getSupabase } from "@/lib/supabase";

export async function POST(req: NextRequest) {
  try {
    const supabase = getSupabase();
    const { companyName, email, password } = await req.json();

    if (!companyName || !email || !password) {
      return NextResponse.json({ error: "All fields required." }, { status: 400 });
    }
    if (password.length < 8) {
      return NextResponse.json({ error: "Password must be at least 8 characters." }, { status: 400 });
    }

    const { data: existing } = await supabase
      .from("users")
      .select("id")
      .eq("email", email)
      .single();

    if (existing) {
      return NextResponse.json({ error: "An account with that email already exists." }, { status: 409 });
    }

    const slug = await makeSlugUnique(
      companyName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48)
    );

    const passwordHash = await bcrypt.hash(password, 12);
    const tenantId = randomUUID();
    const now = new Date().toISOString();

    const { error: tenantErr } = await supabase.from("tenants").insert({
      id: tenantId, name: companyName, slug, trade: "HVAC",
      created_at: now, updated_at: now,
    });
    if (tenantErr) throw new Error(`tenants insert failed: ${tenantErr.message}`);

    const { error: userErr } = await supabase.from("users").insert({
      id: randomUUID(), tenant_id: tenantId, email,
      password_hash: passwordHash, role: "OWNER",
      created_at: now, updated_at: now,
    });
    if (userErr) throw new Error(`users insert failed: ${userErr.message}`);

    const { error: goalsErr } = await supabase.from("tenant_goals").insert({
      id: randomUUID(), tenant_id: tenantId,
      monthly_revenue_goal: 0, monthly_sold_hour_goal: 0,
      weekly_revenue_goal: 0, weekly_sold_hour_goal: 0,
      working_days_month: 20, created_at: now, updated_at: now,
    });
    if (goalsErr) throw new Error(`tenant_goals insert failed: ${goalsErr.message}`);

    const { error: crmErr } = await supabase.from("crm_credentials").insert({
      id: randomUUID(), tenant_id: tenantId,
      provider: "MANUAL", created_at: now, updated_at: now,
    });
    if (crmErr) throw new Error(`crm_credentials insert failed: ${crmErr.message}`);

    const { error: unitsErr } = await supabase.from("business_units").insert([
      { id: randomUUID(), tenant_id: tenantId, sort_order: 0, name: "Maintenance",     target_close_rate: 65, target_rpl: 454,   includes_install: false, created_at: now, updated_at: now },
      { id: randomUUID(), tenant_id: tenantId, sort_order: 1, name: "Demand Service",  target_close_rate: 50, target_rpl: 1100,  includes_install: false, created_at: now, updated_at: now },
      { id: randomUUID(), tenant_id: tenantId, sort_order: 2, name: "Equipment Sales", target_close_rate: 50, target_rpl: 12000, includes_install: true,  created_at: now, updated_at: now },
    ]);
    if (unitsErr) throw new Error(`business_units insert failed: ${unitsErr.message}`);

    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error(err);
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: `Server error: ${message}` }, { status: 500 });
  }
}

async function makeSlugUnique(base: string): Promise<string> {
  const supabase = getSupabase();
  let slug = base;
  let i = 1;
  while (true) {
    const { data } = await supabase.from("tenants").select("id").eq("slug", slug).single();
    if (!data) return slug;
    slug = `${base}-${i++}`;
  }
}