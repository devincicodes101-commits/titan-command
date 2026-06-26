import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { getSupabase } from "@/lib/supabase";
import { getBusinessUnits } from "@/lib/servicetitan";

export async function GET() {
  try {
    const session = await auth();
    if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const supabase = getSupabase();
    const { data: cred, error } = await supabase
      .from("crm_credentials")
      .select("st_tenant_id, app_key, client_id, client_secret_encrypted")
      .eq("tenant_id", session.user.tenantId)
      .eq("provider", "servicetitan")
      .single();
    if (error || !cred) {
      return NextResponse.json({ error: "ServiceTitan is not connected yet" }, { status: 400 });
    }

    const units = await getBusinessUnits({
      stTenantId: cred.st_tenant_id,
      appKey: cred.app_key,
      clientId: cred.client_id,
      clientSecretEncrypted: cred.client_secret_encrypted,
    });

    return NextResponse.json({ units });
  } catch (err) {
    console.error(err);
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: `Server error: ${message}` }, { status: 500 });
  }
}
