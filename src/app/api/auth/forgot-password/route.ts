import { NextRequest, NextResponse } from "next/server";
import { randomBytes, randomUUID } from "crypto";
import { getSupabase } from "@/lib/supabase";
import { sendPasswordResetEmail } from "@/lib/email";

export async function POST(req: NextRequest) {
  try {
    const { email } = await req.json();
    if (!email) {
      return NextResponse.json({ error: "Email is required." }, { status: 400 });
    }

    const supabase = getSupabase();
    const { data: user } = await supabase
      .from("users")
      .select("id, email")
      .eq("email", email)
      .single();

    // Always return the same response whether or not the account exists,
    // so this endpoint can't be used to enumerate registered emails.
    if (user) {
      const token = randomBytes(32).toString("hex");
      const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();

      const { error: insertErr } = await supabase.from("password_reset_tokens").insert({
        id: randomUUID(),
        user_id: user.id,
        token,
        expires_at: expiresAt,
        used: false,
        created_at: new Date().toISOString(),
      });
      if (insertErr) throw new Error(`password_reset_tokens insert failed: ${insertErr.message}`);

      const baseUrl = process.env.NEXTAUTH_URL || req.nextUrl.origin;
      const resetUrl = `${baseUrl}/reset-password?token=${token}`;
      await sendPasswordResetEmail(user.email, resetUrl);
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error(err);
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: `Server error: ${message}` }, { status: 500 });
  }
}
