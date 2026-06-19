"use client";
import { useEffect, useState } from "react";

type Trade = "HVAC" | "Plumbing" | "Electrical" | "Solar" | "Garage Doors" | "Roofing" | "Pools" | "Landscape" | "Other";
const TRADE_DB_MAP: Record<Trade, string> = {
  HVAC: "HVAC", Plumbing: "PLUMBING", Electrical: "ELECTRICAL", Solar: "SOLAR",
  "Garage Doors": "GARAGE_DOORS", Roofing: "ROOFING", Pools: "POOLS", Landscape: "LANDSCAPE", Other: "OTHER",
};
const TRADE_DISPLAY_MAP: Record<string, Trade> = Object.fromEntries(
  Object.entries(TRADE_DB_MAP).map(([k, v]) => [v, k as Trade])
);

interface Unit { name: string; targetCloseRate: number; targetRpl: number; includesInstall: boolean; }

export default function SettingsPage() {
  const [trade, setTrade] = useState<Trade>("HVAC");
  const [monthlyRevenueGoal, setMonthlyRevenueGoal] = useState(0);
  const [monthlySoldHourGoal, setMonthlySoldHourGoal] = useState(0);
  const [weeklyRevenueGoal, setWeeklyRevenueGoal] = useState(0);
  const [weeklySoldHourGoal, setWeeklySoldHourGoal] = useState(0);
  const [workingDaysMonth, setWorkingDaysMonth] = useState(20);
  const [units, setUnits] = useState<Unit[]>([]);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/settings/goals")
      .then((r) => r.json())
      .then((data) => {
        if (data.goals) {
          setMonthlyRevenueGoal(data.goals.monthlyRevenueGoal);
          setMonthlySoldHourGoal(data.goals.monthlySoldHourGoal);
          setWeeklyRevenueGoal(data.goals.weeklyRevenueGoal);
          setWeeklySoldHourGoal(data.goals.weeklySoldHourGoal);
          setWorkingDaysMonth(data.goals.workingDaysMonth);
        }
        if (data.trade) setTrade(TRADE_DISPLAY_MAP[data.trade] ?? "HVAC");
        if (data.units?.length) setUnits(data.units);
        setLoading(false);
      });
  }, []);

  const autoWeekly = workingDaysMonth > 0
    ? Math.round(monthlyRevenueGoal / (workingDaysMonth / 5) * 100) / 100
    : 0;

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    await fetch("/api/settings/goals", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        goals: { monthlyRevenueGoal, monthlySoldHourGoal, weeklyRevenueGoal, weeklySoldHourGoal, workingDaysMonth },
        units,
        trade: TRADE_DB_MAP[trade],
      }),
    });
    setSaving(false);
    setSaved(true);
    setTimeout(() => setSaved(false), 3000);
  }

  function updateUnit(i: number, key: keyof Unit, val: string | number | boolean) {
    setUnits((prev) => {
      const next = [...prev];
      next[i] = { ...next[i], [key]: val };
      return next;
    });
  }

  if (loading) return <div style={{ padding: "48px", color: "var(--tf-muted)" }}>Loading…</div>;

  return (
    <div className="tf-root" style={styles.root}>
      <div style={styles.wrap}>
        <div style={styles.pageHeader}>
          <h1 style={styles.title}>Settings</h1>
          <p style={styles.subtitle}>Goals and targets — set once, used every morning</p>
        </div>

        <form onSubmit={handleSave}>
          {/* Monthly Goals */}
          <section className="tf-card" style={styles.card}>
            <SectionHead num="01" title="Monthly Goals" />
            <div className="tf-results-grid" style={styles.grid4}>
              <Field label="Monthly Revenue Goal">
                <input type="number" value={monthlyRevenueGoal} min={0} step={100}
                  onChange={(e) => setMonthlyRevenueGoal(parseFloat(e.target.value) || 0)}
                  style={styles.input} />
              </Field>
              <Field label="Monthly Sold Hour Goal">
                <input type="number" value={monthlySoldHourGoal} min={0} step={1}
                  onChange={(e) => setMonthlySoldHourGoal(parseFloat(e.target.value) || 0)}
                  style={styles.input} />
              </Field>
              <Field label="Working Days This Month">
                <input type="number" value={workingDaysMonth} min={1} step={1}
                  onChange={(e) => setWorkingDaysMonth(parseFloat(e.target.value) || 20)}
                  style={styles.input} />
              </Field>
              <Field label="Trade / Industry">
                <select value={trade} onChange={(e) => setTrade(e.target.value as Trade)} style={styles.input}>
                  {(Object.keys(TRADE_DB_MAP) as Trade[]).map((t) => (
                    <option key={t} value={t}>{t}</option>
                  ))}
                </select>
              </Field>
            </div>
          </section>

          {/* Weekly Goals */}
          <section className="tf-card" style={{ ...styles.card, marginTop: "24px" }}>
            <SectionHead num="02" title="Weekly Goals" />
            <p style={styles.hint}>
              Auto-calculated weekly: <strong style={{ color: "var(--tf-orange)" }}>
                {new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(autoWeekly)}
              </strong>{" "}(monthly ÷ weeks in month). Override below if needed.
            </p>
            <div className="tf-results-grid" style={styles.grid4}>
              <Field label="Weekly Revenue Goal">
                <input type="number" value={weeklyRevenueGoal} min={0} step={100}
                  onChange={(e) => setWeeklyRevenueGoal(parseFloat(e.target.value) || 0)}
                  style={styles.input} />
              </Field>
              <Field label="Weekly Sold Hour Goal">
                <input type="number" value={weeklySoldHourGoal} min={0} step={1}
                  onChange={(e) => setWeeklySoldHourGoal(parseFloat(e.target.value) || 0)}
                  style={styles.input} />
              </Field>
            </div>
          </section>

          {/* Business Units */}
          {units.length > 0 && (
            <section className="tf-card" style={{ ...styles.card, marginTop: "24px" }}>
              <SectionHead num="03" title="Business Unit Targets" />
              <div style={styles.tableWrap}>
                <table style={styles.table}>
                  <thead>
                    <tr>
                      {["Business Unit Name", "Target Close %", "Target RPL", "N/A for Prev Sold?"].map((h) => (
                        <th key={h} style={styles.th}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {units.map((u, i) => (
                      <tr key={i}>
                        <td style={styles.td}>
                          <input type="text" value={u.name}
                            onChange={(e) => updateUnit(i, "name", e.target.value)}
                            style={{ ...styles.input, fontSize: "15px" }} />
                        </td>
                        <td style={styles.td}>
                          <input type="number" value={u.targetCloseRate} min={0} max={100}
                            onChange={(e) => updateUnit(i, "targetCloseRate", parseFloat(e.target.value) || 0)}
                            style={{ ...styles.input, fontSize: "15px" }} />
                        </td>
                        <td style={styles.td}>
                          <input type="number" value={u.targetRpl} min={0}
                            onChange={(e) => updateUnit(i, "targetRpl", parseFloat(e.target.value) || 0)}
                            style={{ ...styles.input, fontSize: "15px" }} />
                        </td>
                        <td style={styles.td}>
                          <input type="checkbox" checked={u.includesInstall}
                            onChange={(e) => updateUnit(i, "includesInstall", e.target.checked)}
                            style={{ accentColor: "var(--tf-orange)", width: "18px", height: "18px" }} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          <div style={{ marginTop: "28px", display: "flex", gap: "16px", alignItems: "center" }}>
            <button type="submit" disabled={saving} style={styles.saveBtn}>
              {saving ? "Saving…" : "Save Settings"}
            </button>
            {saved && <span style={{ color: "var(--tf-green)", fontSize: "13px", fontWeight: 700 }}>Saved ✓</span>}
          </div>
        </form>

        {/* CRM placeholder */}
        <section style={{ ...styles.card, marginTop: "32px", opacity: 0.6 }}>
          <SectionHead num="04" title="CRM Integration" />
          <p style={{ color: "var(--tf-muted)", lineHeight: 1.6, margin: 0 }}>
            ServiceTitan and Jobber API connections — coming in a future step.
            Awaiting Reed&apos;s confirmation on: how Today&apos;s Opportunities are counted,
            exact business unit names inside ServiceTitan, and Jobber department parity.
          </p>
        </section>
      </div>
    </div>
  );
}

function SectionHead({ num, title }: { num: string; title: string }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: "12px", marginBottom: "22px" }}>
      <span style={styles.num}>{num}</span>
      <h3 style={styles.h3}>{title}</h3>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label style={styles.label}>{label}</label>
      {children}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  root: { width: "100%", background: "var(--tf-bg)", padding: "32px", fontFamily: "Inter,Arial,sans-serif", minHeight: "100vh" },
  wrap: { maxWidth: "1100px", margin: "0 auto" },
  pageHeader: { marginBottom: "32px" },
  title: { fontFamily: "'Space Grotesk',Inter,Arial,sans-serif", fontSize: "clamp(32px,4vw,52px)", fontWeight: 900, letterSpacing: "-0.05em", textTransform: "uppercase", margin: "0 0 10px", color: "var(--tf-text)" },
  subtitle: { borderLeft: "4px solid var(--tf-orange)", paddingLeft: "12px", color: "var(--tf-text-muted)", textTransform: "uppercase", letterSpacing: "0.04em", fontSize: "13px", margin: 0 },
  card: { background: "rgba(32,31,31,.92)", border: "1px solid rgba(164,140,122,.16)", padding: "28px" },
  grid4: { display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: "18px 22px" },
  label: { display: "block", fontSize: "10px", textTransform: "uppercase", letterSpacing: ".12em", color: "var(--tf-muted)", marginBottom: "8px", fontWeight: 800 },
  input: { width: "100%", background: "#0e0e0e", border: "none", borderBottom: "2px solid rgba(86,67,52,.7)", color: "var(--tf-text)", padding: "10px", outline: "none", fontFamily: "'Space Grotesk',Inter,Arial,sans-serif", fontSize: "18px", fontWeight: 800, borderRadius: 0 },
  hint: { color: "var(--tf-muted)", fontSize: "13px", marginBottom: "18px", lineHeight: 1.5 },
  h3: { fontFamily: "'Space Grotesk',Inter,Arial,sans-serif", margin: 0, letterSpacing: "-.02em", textTransform: "uppercase", fontSize: "20px" },
  num: { width: "32px", height: "32px", display: "inline-flex", alignItems: "center", justifyContent: "center", background: "var(--tf-orange)", color: "#2f1500", fontSize: "12px", fontWeight: 900, borderRadius: "3px" },
  tableWrap: { overflowX: "auto" },
  table: { width: "100%", borderCollapse: "collapse" },
  th: { textAlign: "left", color: "var(--tf-muted)", fontSize: "10px", textTransform: "uppercase", letterSpacing: ".12em", padding: "12px", borderBottom: "1px solid rgba(164,140,122,.22)" },
  td: { padding: "10px 12px", borderBottom: "1px solid rgba(164,140,122,.12)", verticalAlign: "middle" },
  saveBtn: { background: "linear-gradient(135deg,var(--tf-orange-soft),var(--tf-orange))", color: "#2f1500", fontFamily: "'Space Grotesk',Inter,Arial,sans-serif", fontWeight: 900, fontSize: "14px", textTransform: "uppercase", letterSpacing: ".12em", padding: "14px 28px", border: "none", cursor: "pointer", borderRadius: "3px" },
};