import { Resend } from "resend";

export async function sendPasswordResetEmail(to: string, resetUrl: string) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) throw new Error("Missing env var: RESEND_API_KEY is not set on this deployment");

  const resend = new Resend(apiKey);
  const from = process.env.RESEND_FROM_EMAIL || "Titan Command Board <onboarding@resend.dev>";

  const { error } = await resend.emails.send({
    from,
    to,
    subject: "Reset your Titan Daily Command Board password",
    html: `
      <div style="background:#0e0e0e;padding:32px;font-family:Arial,sans-serif;">
        <div style="max-width:440px;margin:0 auto;background:#201f1f;border-top:3px solid #ff8c00;padding:32px;">
          <h1 style="color:#e5e2e1;font-size:20px;margin:0 0 16px;">Reset your password</h1>
          <p style="color:#ddc1ae;font-size:14px;line-height:1.6;">
            Click the button below to set a new password. This link expires in 1 hour.
          </p>
          <a href="${resetUrl}" style="display:inline-block;margin-top:16px;background:#ff8c00;color:#2f1500;font-weight:900;text-transform:uppercase;letter-spacing:0.08em;font-size:13px;padding:14px 24px;text-decoration:none;border-radius:3px;">
            Reset Password
          </a>
          <p style="color:#a48c7a;font-size:12px;margin-top:24px;">
            If you didn't request this, you can safely ignore this email.
          </p>
        </div>
      </div>
    `,
  });

  if (error) throw new Error(`Resend send failed: ${error.message}`);
}
