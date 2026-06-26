import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { getSupabase } from "@/lib/supabase";
import { encrypt } from "@/lib/crypto";
import { testConnection } from "@/lib/servicetitan";

export async function GET() {
  try {
    const session = await auth();
    if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const supabase = getSupabase();
    const { data, error } = await supabase
      .from("crm_credentials")
      .select("provider, st_tenant_id, app_key, connected, updated_at")
      .eq("tenant_id", session.user.tenantId);
    if (error) throw new Error(`crm_credentials select failed: ${error.message}`);

    return NextResponse.json({ credentials: data ?? [] });
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

    const { stTenantId, appKey, clientId, clientSecret } = await req.json();
    if (!stTenantId || !appKey || !clientId || !clientSecret) {
      return NextResponse.json({ error: "All fields are required" }, { status: 400 });
    }

    const clientSecretEncrypted = encrypt(clientSecret);
    const result = await testConnection({ stTenantId, appKey, clientId, clientSecretEncrypted });
    if (!result.ok) {
      return NextResponse.json(
        { error: `Connection test failed — check your credentials: ${result.error}` },
        { status: 400 }
      );
    }

    const supabase = getSupabase();
    const now = new Date().toISOString();
    const { error } = await supabase.from("crm_credentials").upsert(
      {
        tenant_id: session.user.tenantId,
        provider: "servicetitan",
        st_tenant_id: stTenantId,
        app_key: appKey,
        client_id: clientId,
        client_secret_encrypted: clientSecretEncrypted,
        connected: true,
        updated_at: now,
      },
      { onConflict: "tenant_id,provider" }
    );
    if (error) throw new Error(`crm_credentials upsert failed: ${error.message}`);

    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error(err);
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: `Server error: ${message}` }, { status: 500 });
  }
}
