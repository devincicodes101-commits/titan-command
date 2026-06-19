"use client";
import { useState } from "react";
import Link from "next/link";

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [sent, setSent] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);

    const res = await fetch("/api/auth/forgot-password", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email }),
    });

    setLoading(false);
    if (!res.ok) {
      const data = await res.json();
      setError(data.error ?? "Something went wrong.");
      return;
    }
    setSent(true);
  }

  return (
    <div style={styles.page}>
      <div style={styles.card}>
        <h1 style={styles.title}>
          Titan Daily<br />
          <span style={{ color: "var(--tf-orange)" }}>Command Board</span>
        </h1>
        <p style={styles.subtitle}>Reset your password</p>

        {sent ? (
          <p style={styles.success}>
            If an account exists for that email, a reset link has been sent. Check your inbox.
          </p>
        ) : (
          <form onSubmit={handleSubmit} style={styles.form}>
            <div style={styles.field}>
              <label style={styles.label}>Email</label>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                autoFocus
                style={styles.input}
                placeholder="you@company.com"
              />
            </div>

            {error && <p style={styles.error}>{error}</p>}

            <button type="submit" disabled={loading} style={styles.button}>
              {loading ? "Sending…" : "Send Reset Link"}
            </button>
          </form>
        )}

        <p style={styles.footer}>
          <Link href="/login" style={styles.link}>Back to sign in</Link>
        </p>
      </div>
      <p style={styles.copyright}>Copyright 2026 Said Company Consulting Inc.</p>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  page: {
    minHeight: "100vh", background: "var(--tf-bg)", display: "flex",
    flexDirection: "column", alignItems: "center", justifyContent: "center",
    padding: "24px", gap: "20px",
  },
  card: {
    width: "100%", maxWidth: "440px", background: "var(--tf-card)",
    border: "1px solid rgba(164,140,122,.18)", borderTop: "3px solid var(--tf-orange)",
    padding: "40px 36px",
  },
  title: {
    fontFamily: "'Space Grotesk', Inter, Arial, sans-serif", fontSize: "clamp(28px, 5vw, 40px)",
    fontWeight: 900, letterSpacing: "-0.05em", textTransform: "uppercase",
    lineHeight: 0.95, margin: "0 0 10px", color: "var(--tf-text)",
  },
  subtitle: {
    color: "var(--tf-muted)", fontSize: "13px", letterSpacing: "0.06em",
    textTransform: "uppercase", borderLeft: "4px solid var(--tf-orange)",
    paddingLeft: "12px", margin: "0 0 32px",
  },
  form: { display: "flex", flexDirection: "column", gap: "20px" },
  field: { display: "flex", flexDirection: "column" },
  label: {
    fontSize: "10px", fontWeight: 800, textTransform: "uppercase",
    letterSpacing: "0.12em", color: "var(--tf-muted)", marginBottom: "8px",
  },
  input: {
    background: "var(--tf-bg)", border: "none", borderBottom: "2px solid rgba(86,67,52,.7)",
    color: "var(--tf-text)", padding: "12px", fontFamily: "'Space Grotesk', Inter, Arial, sans-serif",
    fontSize: "16px", fontWeight: 700, outline: "none", borderRadius: 0, width: "100%",
  },
  error: {
    color: "var(--tf-red)", fontSize: "13px", margin: 0, padding: "10px 14px",
    background: "rgba(255,107,95,.08)", border: "1px solid rgba(255,107,95,.3)",
  },
  success: {
    color: "var(--tf-green)", fontSize: "14px", lineHeight: 1.6, margin: 0,
    padding: "16px", background: "rgba(87,214,141,.08)", border: "1px solid rgba(87,214,141,.3)",
  },
  button: {
    background: "linear-gradient(135deg, var(--tf-orange-soft), var(--tf-orange))",
    color: "#2f1500", fontFamily: "'Space Grotesk', Inter, Arial, sans-serif",
    fontWeight: 900, fontSize: "14px", textTransform: "uppercase", letterSpacing: "0.12em",
    padding: "14px 18px", border: "none", cursor: "pointer", borderRadius: "3px",
    width: "100%", marginTop: "4px",
  },
  footer: { color: "var(--tf-muted)", fontSize: "13px", textAlign: "center", marginTop: "24px" },
  link: { color: "var(--tf-orange)", textDecoration: "none", fontWeight: 700 },
  copyright: { color: "rgba(164,140,122,.4)", fontSize: "11px" },
};
