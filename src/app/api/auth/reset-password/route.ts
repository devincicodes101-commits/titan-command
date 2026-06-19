import { NextRequest, NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { getSupabase } from "@/lib/supabase";

export async function POST(req: NextRequest) {
  try {
    const { token, password } = await req.json();
    if (!token || !password) {
      return NextResponse.json({ error: "Token and password are required." }, { status: 400 });
    }
    if (password.length < 8) {
      return NextResponse.json({ error: "Password must be at least 8 characters." }, { status: 400 });
    }

    const supabase = getSupabase();
    const { data: resetToken } = await supabase
      .from("password_reset_tokens")
      .select("*")
      .eq("token", token)
      .single();

    if (!resetToken) {
      return NextResponse.json({ error: "This reset link is invalid." }, { status: 400 });
    }
    if (resetToken.used) {
      return NextResponse.json({ error: "This reset link has already been used." }, { status: 400 });
    }
    if (new Date(resetToken.expires_at) < new Date()) {
      return NextResponse.json({ error: "This reset link has expired. Please request a new one." }, { status: 400 });
    }

    const passwordHash = await bcrypt.hash(password, 12);

    const { error: updateErr } = await supabase
      .from("users")
      .update({ password_hash: passwordHash, updated_at: new Date().toISOString() })
      .eq("id", resetToken.user_id);
    if (updateErr) throw new Error(`users update failed: ${updateErr.message}`);

    const { error: markUsedErr } = await supabase
      .from("password_reset_tokens")
      .update({ used: true })
      .eq("id", resetToken.id);
    if (markUsedErr) throw new Error(`password_reset_tokens update failed: ${markUsedErr.message}`);

    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error(err);
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: `Server error: ${message}` }, { status: 500 });
  }
}
