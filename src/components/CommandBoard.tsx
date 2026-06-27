"use client";
import { useState, useEffect, useCallback } from "react";
import {
  calculateBoard,
  calculateUnit,
  type BoardInputs,
  type UnitInputs,
  type UnitOutputs,
} from "@/lib/calculations";

// ─── Types ──────────────────────────────────────────────────────────────────

type Trade =
  | "HVAC" | "Plumbing" | "Electrical" | "Solar"
  | "Garage Doors" | "Roofing" | "Pools" | "Landscape" | "Other";

interface SavedGoals {
  monthlyRevenueGoal: number;
  monthlySoldHourGoal: number;
  weeklyRevenueGoal: number;
  weeklySoldHourGoal: number;
  workingDaysMonth: number;
  trade: Trade;
  businessUnits: { name: string; targetCloseRate: number; targetRpl: number; includesInstall: boolean }[];
}

interface LiveRevenue {
  mtdRevenue: number;
  wtdRevenue: number;
  yesterdayRevenue: number;
}

interface Props {
  savedGoals?: SavedGoals | null;
  serviceTitanConnected?: boolean;
  liveRevenue?: LiveRevenue | null;
  liveRevenueError?: string | null;
  liveDeptPerformance?: Record<string, { revenue: number; jobsCompleted: number }> | null;
}

// ─── Trade → Business Unit names ────────────────────────────────────────────

function unitNamesForTrade(trade: Trade, savedUnits?: SavedGoals["businessUnits"]) {
  if (savedUnits && savedUnits.length > 0) return savedUnits.map((u) => u.name);
  switch (trade) {
    case "Plumbing":    return ["Maintenance", "Demand Service", "Digs / Sewer Replacement"];
    case "Electrical":  return ["Maintenance", "Demand Service", "Service Upgrades"];
    case "Garage Doors":return ["Maintenance", "Demand Service", "Door Installation Sales"];
    case "Roofing":     return ["Demand Repair", "Roofing Installation Sales"];
    case "Pools":       return ["Maintenance", "Demand Service", "Pool / Spa Sales"];
    case "Landscape":   return ["Yard Maintenance", "Softscaping", "Hardscaping"];
    default:            return ["Maintenance", "Demand Service", "Equipment Sales"];
  }
}

function showInstallBoard(trade: Trade) {
  return trade === "HVAC" || trade === "Other";
}

function showDeptPerformance(trade: Trade) {
  return trade === "HVAC";
}

function pad(n: number) {
  return String(n).padStart(2, "0");
}

// ─── Formatting helpers (must match HTML exactly) ────────────────────────────

function fmtCurrency(val: number) {
  return new Intl.NumberFormat("en-US", {
    style: "currency", currency: "USD", maximumFractionDigits: 0,
  }).format(isFinite(val) ? val : 0);
}
function fmtPct(val: number) {
  return Math.round(isFinite(val) ? val : 0) + "%";
}

// ─── Default state ───────────────────────────────────────────────────────────

function defaultUnits(trade: Trade, saved?: SavedGoals["businessUnits"]): UnitInputs[] {
  const names = unitNamesForTrade(trade, saved);
  const targets = saved ?? [
    { name: "", targetCloseRate: 65, targetRpl: 454, includesInstall: false },
    { name: "", targetCloseRate: 50, targetRpl: 1100, includesInstall: false },
    { name: "", targetCloseRate: 50, targetRpl: 12000, includesInstall: true },
  ];
  return names.map((name, i) => ({
    name,
    mtdOpps: 0,
    targetCloseRate: targets[i]?.targetCloseRate ?? 50,
    actualCloseRate: 0,
    mtdSales: 0,
    prevSoldToday: 0,
    targetRpl: targets[i]?.targetRpl ?? 1000,
    includesInstall: targets[i]?.includesInstall ?? false,
  }));
}

// ─── Component ───────────────────────────────────────────────────────────────

export default function CommandBoard({ savedGoals, serviceTitanConnected, liveRevenue, liveRevenueError, liveDeptPerformance }: Props) {
  const today = new Date().toLocaleDateString("en-US", {
    weekday: "long", year: "numeric", month: "long", day: "numeric",
  });

  const [trade, setTrade] = useState<Trade>(savedGoals?.trade ?? "HVAC");
  const monthlyRevenueGoalInit = savedGoals?.monthlyRevenueGoal ?? 179000;
  const monthlySoldHourGoalInit = savedGoals?.monthlySoldHourGoal ?? 1134;
  const workingDaysMonthInit = savedGoals?.workingDaysMonth ?? 20;
  const weeksInMonth = workingDaysMonthInit / 5;
  // Per spec, weekly goals derive from the monthly goal — only treat a saved
  // weekly value as a deliberate override when it's actually non-zero.
  const [inputs, setInputs] = useState<BoardInputs>({
    monthlyRevenueGoal: monthlyRevenueGoalInit,
    monthlySoldHourGoal: monthlySoldHourGoalInit,
    workingDaysMonth: workingDaysMonthInit,
    workingDaysLeftMonth: 16,
    weeklyRevenueGoal: savedGoals?.weeklyRevenueGoal || Math.round(monthlyRevenueGoalInit / weeksInMonth),
    weeklySoldHourGoal: savedGoals?.weeklySoldHourGoal || Math.round(monthlySoldHourGoalInit / weeksInMonth),
    workingDaysLeftWeek: 2,
    mtdRevenue: liveRevenue?.mtdRevenue ?? 39000,
    wtdRevenue: liveRevenue?.wtdRevenue ?? 16000,
    yesterdayRevenue: liveRevenue?.yesterdayRevenue ?? 4000,
    totalMtdCalls: 32,
    mtdSoldHours: 122,
    todayOpportunities: 4,
    techsAvailableToday: 5,
    avgSoldHoursPerTech: 5,
    installCrews: 2,
    installRevenue: 25000,
    daysBookedOut: 7,
    equipmentSalesRevenue: 39016,
  });
  const [units, setUnits] = useState<UnitInputs[]>(() =>
    defaultUnits(trade, savedGoals?.businessUnits)
  );

  const [deptPerformance, setDeptPerformance] = useState<Record<string, { revenue: number; jobsCompleted: number }>>({
    Maintenance: liveDeptPerformance?.Maintenance ?? { revenue: 0, jobsCompleted: 0 },
    Service: liveDeptPerformance?.Service ?? { revenue: 0, jobsCompleted: 0 },
    Installation: liveDeptPerformance?.Installation ?? { revenue: 0, jobsCompleted: 0 },
  });

  // Re-map unit names when trade changes (but keep numeric values)
  useEffect(() => {
    const names = unitNamesForTrade(trade, savedGoals?.businessUnits);
    setUnits((prev) =>
      names.map((name, i) => ({
        ...(prev[i] ?? { mtdOpps: 0, actualCloseRate: 0, mtdSales: 0, prevSoldToday: 0 }),
        name,
        targetCloseRate: prev[i]?.targetCloseRate ?? 50,
        targetRpl: prev[i]?.targetRpl ?? 1000,
        includesInstall: prev[i]?.includesInstall ?? false,
      }))
    );
  }, [trade]); // eslint-disable-line react-hooks/exhaustive-deps

  const setInput = useCallback((key: keyof BoardInputs, val: number) => {
    setInputs((prev) => ({ ...prev, [key]: val }));
  }, []);

  const setUnit = useCallback((i: number, key: keyof UnitInputs, val: number) => {
    setUnits((prev) => {
      const next = [...prev];
      next[i] = { ...next[i], [key]: val };
      return next;
    });
  }, []);

  const visibleUnits = trade === "Roofing" ? units.slice(0, 2) : units;
  const daysElapsed = Math.max(1, inputs.workingDaysMonth - inputs.workingDaysLeftMonth);
  const board = calculateBoard(inputs, visibleUnits);
  const unitOutputs: UnitOutputs[] = visibleUnits.map((u) => calculateUnit(u, daysElapsed));

  const salesUnitIndex = visibleUnits.findIndex((u) => u.includesInstall);
  const salesDept = salesUnitIndex >= 0
    ? { revenue: visibleUnits[salesUnitIndex].mtdSales, jobsCompleted: unitOutputs[salesUnitIndex].closedJobs, avgTicket: unitOutputs[salesUnitIndex].avgSale }
    : { revenue: 0, jobsCompleted: 0, avgTicket: 0 };

  const setDept = useCallback((name: string, key: "revenue" | "jobsCompleted", val: number) => {
    setDeptPerformance((prev) => ({ ...prev, [name]: { ...prev[name], [key]: val } }));
  }, []);

  let sectionNum = 5;
  const installSectionNum = showInstallBoard(trade) ? sectionNum++ : null;
  const deptSectionNum = showDeptPerformance(trade) ? sectionNum++ : null;
  const foundrySectionNum = sectionNum;

  return (
    <div className="tf-root" style={styles.root}>
      <div style={styles.wrap}>

        {/* ── Header ──────────────────────────────────────────────── */}
        <div className="tf-header" style={styles.header}>
          <div>
            <h1 style={styles.title}>
              Titan Daily<br />
              <span style={{ color: "var(--tf-orange)" }}>Command Board</span>
            </h1>
            <p style={styles.headerSubtitle}>
              Turn monthly targets, tech capacity, and today&apos;s opportunities into the execution number.
            </p>
          </div>
          <div style={styles.statusBox}>
            <span style={styles.kicker}>Status</span>
            <div style={styles.liveRow}>
              <span style={{ ...styles.liveDot, background: serviceTitanConnected ? "var(--tf-green)" : "var(--tf-orange)", boxShadow: serviceTitanConnected ? "0 0 18px rgba(46,204,113,.7)" : "0 0 18px rgba(255,140,0,.7)" }} />
              <span style={styles.liveText}>
                {serviceTitanConnected ? "ServiceTitan Connected" : "Titan Daily Command Board"}
              </span>
            </div>
          </div>
        </div>

        {/* ── Scoreboard ──────────────────────────────────────────── */}
        <div className="tf-scoreboard" style={styles.scoreboard}>
          <ScoreCard label="Daily Command Goal" value={fmtCurrency(board.dailyCommandGoal)} main
            tip="The higher of Revenue Needed Today and Weekly Need Today." />
          <ScoreCard label="Revenue Needed Today" value={fmtCurrency(board.revenueNeededToday)}
            tip="Monthly revenue still needed divided by working days left in the month." />
          <ScoreCard label="Weekly Need Today" value={fmtCurrency(board.weeklyNeededToday)}
            tip="Weekly revenue still needed divided by working days left in the week." />
          <ScoreCard label="Sold Hours Needed" value={board.soldHoursNeeded.toFixed(1)}
            tip="Monthly sold hours still needed divided by working days left in the month." />
          <ScoreCard label="Avg Ticket Needed" value={fmtCurrency(board.avgTicketNeeded)}
            tip="New revenue needed today divided by today's opportunities." />
        </div>

        {/* ── Section 01 + 02 ─────────────────────────────────────── */}
        <div className="tf-two-col" style={styles.twoCol}>
          <section className="tf-card" style={styles.card}>
            <SectionHead num="01" title="Monthly / Weekly Setup" />
            <InputGrid>
              <InputField label="Today's Date" value={today} readOnly />
              <div>
                <label style={styles.label}>Trade</label>
                <select
                  value={trade}
                  onChange={(e) => setTrade(e.target.value as Trade)}
                  style={styles.input}
                >
                  {(["HVAC","Plumbing","Electrical","Solar","Garage Doors","Roofing","Pools","Landscape","Other"] as Trade[]).map((t) => (
                    <option key={t} value={t}>{t}</option>
                  ))}
                </select>
              </div>
              <NumField label="Monthly Revenue Goal" val={inputs.monthlyRevenueGoal} onChange={(v) => setInput("monthlyRevenueGoal", v)} />
              <NumField label="Monthly Sold Hour Goal" val={inputs.monthlySoldHourGoal} onChange={(v) => setInput("monthlySoldHourGoal", v)} />
              <NumField label="Working Days This Month" val={inputs.workingDaysMonth} onChange={(v) => setInput("workingDaysMonth", v)} step={1} />
              <NumField label="Working Days Left This Month" val={inputs.workingDaysLeftMonth} onChange={(v) => setInput("workingDaysLeftMonth", v)} step={1} />
              <NumField label="Weekly Revenue Goal" val={inputs.weeklyRevenueGoal} onChange={(v) => setInput("weeklyRevenueGoal", v)} />
              <NumField label="Weekly Sold Hour Goal" val={inputs.weeklySoldHourGoal} onChange={(v) => setInput("weeklySoldHourGoal", v)} step={1} />
              <NumField label="Working Days Left This Week" val={inputs.workingDaysLeftWeek} onChange={(v) => setInput("workingDaysLeftWeek", v)} step={1} />
            </InputGrid>
          </section>

          <section className="tf-card" style={styles.card}>
            <SectionHead num="02" title="Morning CRM Inputs" />
            {liveRevenueError && (
              <p style={{ color: "var(--tf-red)", fontSize: "12px", marginTop: "-12px", marginBottom: "16px" }}>
                ServiceTitan live pull failed: {liveRevenueError}
              </p>
            )}
            <InputGrid>
              <NumField label={liveRevenue ? "MTD Revenue (Live ⚡)" : "MTD Revenue"} val={inputs.mtdRevenue} onChange={(v) => setInput("mtdRevenue", v)} />
              <NumField label={liveRevenue ? "WTD Revenue (Live ⚡)" : "WTD Revenue"} val={inputs.wtdRevenue} onChange={(v) => setInput("wtdRevenue", v)} />
              <NumField label={liveRevenue ? "Yesterday Revenue (Live ⚡)" : "Yesterday Revenue"} val={inputs.yesterdayRevenue} onChange={(v) => setInput("yesterdayRevenue", v)} />
              <NumField label="Total MTD Calls Ran" val={inputs.totalMtdCalls} onChange={(v) => setInput("totalMtdCalls", v)} step={1} />
              <NumField label="MTD Sold Hours" val={inputs.mtdSoldHours} onChange={(v) => setInput("mtdSoldHours", v)} step={0.1} />
              <NumField label="Today's Opportunities" val={inputs.todayOpportunities} onChange={(v) => setInput("todayOpportunities", v)} step={1} />
              <NumField label="Techs Available Today" val={inputs.techsAvailableToday} onChange={(v) => setInput("techsAvailableToday", v)} step={1} />
              <NumField label="Avg Sold Hours / Tech Today" val={inputs.avgSoldHoursPerTech} onChange={(v) => setInput("avgSoldHoursPerTech", v)} step={0.1} />
            </InputGrid>
          </section>
        </div>

        {/* ── Section 03 — Today's Targets ────────────────────────── */}
        <section className="tf-card" style={{ ...styles.card, marginTop: "24px" }}>
          <SectionHead num="03" title="Today's Targets" />
          <div className="tf-results-grid" style={styles.resultsGrid}>
            <ResultBox label="Leads Needed Today" value={String(board.leadsNeeded)}
              tip="New revenue needed today divided by company Revenue Per Lead, rounded up." />
            <ResultBox label="Sales Needed Today" value={String(board.salesNeeded)}
              tip="New revenue needed today divided by company average sale, rounded up." />
            <ResultBox label="Available Tech Capacity" value={`${board.techCapacityToday.toFixed(1)} hrs`}
              tip="Techs available today multiplied by average sold hours per tech today." />
            <ResultBox label="Capacity Signal"
              value={board.capacityOk ? "Capacity OK" : "Capacity Gap"}
              colorClass={board.capacityOk ? "good" : "bad"}
              tip="Compares available tech capacity to sold hours needed today." />
            <ResultBox label="Company Revenue Per Lead" value={fmtCurrency(board.companyRpl)}
              tip="MTD revenue divided by total MTD calls ran." />
            <ResultBox label="Company Average Sale" value={fmtCurrency(board.companyAvgSale)}
              tip="Total business-unit MTD sales divided by total closed jobs." />
            <ResultBox label="Avg Ticket Needed Today" value={fmtCurrency(board.avgTicketNeeded)}
              tip="New revenue needed today divided by today's opportunities." />
            <ResultBox label="Revenue Gap to Goal"
              value={fmtCurrency(board.revenueGap)}
              colorClass={board.revenueGap >= 0 ? "good" : "bad"}
              tip="MTD revenue minus where revenue should be by this point. Positive = ahead, Negative = behind." />
            <ResultBox label="Previously Sold Work Today" value={fmtCurrency(board.totalPrevSold)}
              tip="Total previously sold work scheduled to be completed today from the business-unit table." />
            <ResultBox label="New Revenue Needed Today" value={fmtCurrency(board.newRevenueNeeded)}
              tip="Daily Command Goal minus previously sold work scheduled for completion today." />
            <ResultBox label="Monthly Revenue Pace" value={fmtCurrency(board.monthlyPace)}
              tip="MTD revenue divided by elapsed working days this month." />
            <ResultBox label="Daily Pace Needed" value={fmtCurrency(board.revenueNeededToday)}
              tip="Monthly revenue still needed divided by working days left in the month." />
            <ResultBox label="Command Signal"
              value={board.signal}
              colorClass={board.signal === "Attackable" ? "good" : board.signal === "Heavy Push" ? "watch" : board.signal === "Needs More Leads" ? "bad" : "watch"}
              tip="A simple execution signal based on the close rate required to hit today's command goal." />
          </div>
        </section>

        {/* ── Section 04 — Business Unit Scoreboard ───────────────── */}
        <section className="tf-card" style={{ ...styles.card, marginTop: "24px" }}>
          <SectionHead num="04" title="Business Unit Scoreboard" />
          <div style={styles.tableWrap}>
            <table style={styles.table}>
              <thead>
                <tr>
                  {["Business Unit","MTD Opps","Target Close %","Actual Close %","MTD Sales $","Previously Sold Work Today","Target RPL","Actual RPL","Closed Jobs","Avg Sale","Monthly Pace","Signal"].map((h) => (
                    <th key={h} style={styles.th}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {visibleUnits.map((unit, i) => {
                  const out = unitOutputs[i];
                  return (
                    <tr key={i}>
                      <td style={{ ...styles.td, fontFamily: "'Space Grotesk',Inter,Arial,sans-serif", fontWeight: 900 }}>
                        {unit.name}
                      </td>
                      <td style={styles.td}>
                        <input type="number" value={unit.mtdOpps} min={0}
                          onChange={(e) => setUnit(i, "mtdOpps", parseFloat(e.target.value) || 0)}
                          style={styles.tableInput} />
                      </td>
                      <td style={styles.td}>
                        <input type="number" value={unit.targetCloseRate} min={0} max={100}
                          onChange={(e) => setUnit(i, "targetCloseRate", parseFloat(e.target.value) || 0)}
                          style={styles.tableInput} />
                      </td>
                      <td style={styles.td}>
                        <input type="number" value={unit.actualCloseRate} min={0} max={100}
                          onChange={(e) => setUnit(i, "actualCloseRate", parseFloat(e.target.value) || 0)}
                          style={styles.tableInput} />
                      </td>
                      <td style={styles.td}>
                        <input type="number" value={unit.mtdSales} min={0}
                          onChange={(e) => setUnit(i, "mtdSales", parseFloat(e.target.value) || 0)}
                          style={styles.tableInput} />
                      </td>
                      <td style={styles.td}>
                        {unit.includesInstall
                          ? <div style={styles.lockedCell}>N/A</div>
                          : <input type="number" value={unit.prevSoldToday} min={0}
                              onChange={(e) => setUnit(i, "prevSoldToday", parseFloat(e.target.value) || 0)}
                              style={styles.tableInput} />
                        }
                      </td>
                      <td style={styles.td}>
                        <input type="number" value={unit.targetRpl} min={0}
                          onChange={(e) => setUnit(i, "targetRpl", parseFloat(e.target.value) || 0)}
                          style={styles.tableInput} />
                      </td>
                      <td style={{ ...styles.td, ...styles.tableOutput, color: out.rplGood ? "var(--tf-green)" : out.closeGood ? "var(--tf-yellow)" : "var(--tf-red)" }}>
                        {fmtCurrency(out.actualRpl)}
                      </td>
                      <td style={{ ...styles.td, ...styles.tableOutput }}>{out.closedJobs}</td>
                      <td style={{ ...styles.td, ...styles.tableOutput }}>{fmtCurrency(out.avgSale)}</td>
                      <td style={{ ...styles.td, ...styles.tableOutput }}>{fmtCurrency(out.monthlyPace)}</td>
                      <td style={styles.td}>
                        <span style={{
                          ...styles.pill,
                          color: out.signal === "On Track" ? "var(--tf-green)" : out.signal === "Watch" ? "var(--tf-yellow)" : "var(--tf-red)",
                          borderColor: out.signal === "On Track" ? "var(--tf-green)" : out.signal === "Watch" ? "var(--tf-yellow)" : "var(--tf-red)",
                        }}>
                          {out.signal}
                        </span>
                      </td>
                    </tr>
                  );
                })}
                {/* Totals row */}
                <tr>
                  <td style={{ ...styles.td, ...styles.tableOutput }}>TOTAL / COMPANY</td>
                  <td style={{ ...styles.td, ...styles.tableOutput }}>{board.totalOpps}</td>
                  <td style={styles.td} />
                  <td style={{ ...styles.td, ...styles.tableOutput }}>{fmtPct(board.totalClose)}</td>
                  <td style={{ ...styles.td, ...styles.tableOutput }}>{fmtCurrency(board.totalSales)}</td>
                  <td style={{ ...styles.td, ...styles.tableOutput }}>{fmtCurrency(board.totalPrevSold)}</td>
                  <td style={styles.td} />
                  <td style={{ ...styles.td, ...styles.tableOutput }}>{fmtCurrency(board.totalRpl)}</td>
                  <td style={{ ...styles.td, ...styles.tableOutput }}>{board.totalClosed}</td>
                  <td style={{ ...styles.td, ...styles.tableOutput }}>{fmtCurrency(board.totalAvgSale)}</td>
                  <td style={{ ...styles.td, ...styles.tableOutput }}>{fmtCurrency(board.totalPace)}</td>
                  <td style={styles.td}>
                    <span style={{
                      ...styles.pill,
                      color: board.signal === "Attackable" ? "var(--tf-green)" : board.signal === "Heavy Push" ? "var(--tf-yellow)" : board.signal === "Needs More Leads" ? "var(--tf-red)" : "var(--tf-yellow)",
                      borderColor: board.signal === "Attackable" ? "var(--tf-green)" : board.signal === "Heavy Push" ? "var(--tf-yellow)" : board.signal === "Needs More Leads" ? "var(--tf-red)" : "var(--tf-yellow)",
                    }}>
                      {board.signal}
                    </span>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </section>

        {/* ── Install Board (HVAC only) ──────────────── */}
        {showInstallBoard(trade) && (
          <section className="tf-card" style={{ ...styles.card, marginTop: "24px" }}>
            <SectionHead num={pad(installSectionNum!)} title="Equipment Installation Command Board" />
            <div className="tf-results-grid" style={styles.resultsGrid}>
              <ResultBox label="Install Crews Today" value={String(inputs.installCrews ?? 0)}
                tip="The number of install crews working today." />
              <ResultBox label="MTD Invoiced Install Revenue" value={fmtCurrency(inputs.installRevenue ?? 0)}
                tip="Install revenue invoiced month-to-date." />
              <ResultBox label="Days Booked Out" value={String(inputs.daysBookedOut ?? 0)}
                tip="How many days out the install board is booked." />
              <ResultBox label="Install Revenue Pending" value={fmtCurrency(board.installRevenuePending)}
                tip="MTD Equipment Sales Revenue minus MTD Invoiced Install Revenue." />
            </div>
            <div className="tf-two-col" style={styles.twoCol2}>
              <div style={styles.card2}>
                <h4 style={styles.h4}>Install Operations Inputs</h4>
                <InputGrid>
                  <NumField label="Install Crews Working Today" val={inputs.installCrews ?? 2} onChange={(v) => setInput("installCrews", v)} step={1} />
                  <NumField label="MTD Invoiced Install Revenue" val={inputs.installRevenue ?? 25000} onChange={(v) => setInput("installRevenue", v)} />
                  <NumField label="Days Booked Out" val={inputs.daysBookedOut ?? 7} onChange={(v) => setInput("daysBookedOut", v)} step={1} />
                  <NumField label="MTD Equipment Sales Revenue" val={inputs.equipmentSalesRevenue ?? 39016} onChange={(v) => setInput("equipmentSalesRevenue", v)} />
                </InputGrid>
              </div>
              <div style={styles.card2}>
                <h4 style={styles.h4}>Install Operations Insight</h4>
                <p style={styles.insight}>{board.installInsight}</p>
              </div>
            </div>
          </section>
        )}

        {/* ── Department Performance (HVAC only) ──────────────── */}
        {showDeptPerformance(trade) && (
          <section className="tf-card" style={{ ...styles.card, marginTop: "24px" }}>
            <SectionHead num={pad(deptSectionNum!)} title="Department Performance" />
            <div className="tf-results-grid" style={styles.resultsGrid}>
              <DeptCard label="Sales" revenue={salesDept.revenue} jobsCompleted={salesDept.jobsCompleted} avgTicket={salesDept.avgTicket} />
              {(["Maintenance", "Service", "Installation"] as const).map((name) => {
                const d = deptPerformance[name];
                const avgTicket = d.jobsCompleted > 0 ? d.revenue / d.jobsCompleted : 0;
                return <DeptCard key={name} label={name} revenue={d.revenue} jobsCompleted={d.jobsCompleted} avgTicket={avgTicket} />;
              })}
            </div>
            <div style={{ marginTop: "20px" }}>
              <h4 style={styles.h4}>{liveDeptPerformance ? "Maintenance / Service / Installation (Live ⚡, editable)" : "Manual Entry — Maintenance / Service / Installation"}</h4>
              <div className="tf-input-grid" style={styles.inputGrid}>
                {(["Maintenance", "Service", "Installation"] as const).map((name) => (
                  <div key={name} style={{ display: "contents" }}>
                    <NumField label={`${name} Revenue`} val={deptPerformance[name].revenue} onChange={(v) => setDept(name, "revenue", v)} />
                    <NumField label={`${name} Jobs Completed`} val={deptPerformance[name].jobsCompleted} onChange={(v) => setDept(name, "jobsCompleted", v)} step={1} />
                  </div>
                ))}
              </div>
              <p style={styles.note}>
                {liveDeptPerformance
                  ? "Sales, Maintenance, Service, and Installation all pull live from ServiceTitan (matched by business unit name) — still fully editable if you need to override."
                  : "Sales figures above are pulled automatically from the Equipment Sales row in the Business Unit Scoreboard. Maintenance, Service, and Installation are manual entry until the ServiceTitan connection is built."}
              </p>
            </div>
          </section>
        )}

        {/* ── Foundry Insight ────────────────────────── */}
        <section className="tf-card" style={{ ...styles.card, marginTop: "24px" }}>
          <SectionHead num={pad(foundrySectionNum)} title="Foundry Insight" />
          <p style={styles.insight}>{board.insightText}</p>
          <button
            type="button"
            style={styles.printBtn}
            onClick={() => window.print()}
          >
            Print / Save PDF
          </button>
          <p style={styles.note}>Copyright 2026 Said Company Consulting Inc.</p>
        </section>

        {/* ── Disclaimer ──────────────────────────────────────────── */}
        <div style={styles.disclaimer}>
          <strong style={styles.disclaimerTitle}>Disclaimer</strong>
          The Titan Daily Command Board and all related calculators, forecasts, and projections are provided for informational and educational purposes only. Results are based entirely on the accuracy of the information entered and assumptions selected by the user. Actual business performance, profitability, pricing outcomes, and operational results may vary. Said Company Consulting Inc. and Titan Profit Labs make no guarantees, warranties, or representations regarding financial performance, revenue, profit, efficiency, or business outcomes resulting from the use of this tool.
        </div>

      </div>
    </div>
  );
}

// ─── Sub-components ──────────────────────────────────────────────────────────

function SectionHead({ num, title }: { num: string; title: string }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: "12px", marginBottom: "22px" }}>
      <span style={styles.num}>{num}</span>
      <h3 style={styles.h3}>{title}</h3>
    </div>
  );
}

function ScoreCard({ label, value, main, tip }: { label: string; value: string; main?: boolean; tip: string }) {
  return (
    <div style={{
      ...styles.scoreCard,
      ...(main ? styles.scoreMain : {}),
    }} title={tip}>
      <strong style={styles.scoreLabel}>{label}</strong>
      <span style={{ ...styles.scoreValue, ...(main ? { color: "var(--tf-orange)" } : {}) }}>
        {value}
      </span>
    </div>
  );
}

function InputGrid({ children }: { children: React.ReactNode }) {
  return <div className="tf-input-grid" style={styles.inputGrid}>{children}</div>;
}

function InputField({ label, value, readOnly }: { label: string; value: string; readOnly?: boolean }) {
  return (
    <div>
      <label style={styles.label}>{label}</label>
      <input type="text" value={value} readOnly={readOnly} style={styles.input} />
    </div>
  );
}

function NumField({ label, val, onChange, step = 100 }: {
  label: string; val: number; onChange: (v: number) => void; step?: number;
}) {
  return (
    <div>
      <label style={styles.label}>{label}</label>
      <input
        type="number"
        value={val}
        min={0}
        step={step}
        onChange={(e) => onChange(parseFloat(e.target.value) || 0)}
        style={styles.input}
      />
    </div>
  );
}

type ColorClass = "good" | "bad" | "watch" | undefined;

function ResultBox({ label, value, tip, colorClass }: {
  label: string; value: string; tip: string; colorClass?: ColorClass;
}) {
  const color = colorClass === "good" ? "var(--tf-green)"
    : colorClass === "bad" ? "var(--tf-red)"
    : colorClass === "watch" ? "var(--tf-yellow)"
    : "var(--tf-text)";
  return (
    <div style={styles.resultBox} title={tip}>
      <strong style={styles.resultLabel}>{label}</strong>
      <span style={{ ...styles.resultValue, color }}>{value}</span>
    </div>
  );
}

function DeptCard({ label, revenue, jobsCompleted, avgTicket }: {
  label: string; revenue: number; jobsCompleted: number; avgTicket: number;
}) {
  return (
    <div style={styles.resultBox}>
      <strong style={styles.resultLabel}>{label}</strong>
      <span style={{ ...styles.resultValue, fontSize: "20px" }}>{fmtCurrency(revenue)}</span>
      <div style={{ marginTop: "10px", display: "flex", justifyContent: "space-between", fontSize: "11px", color: "var(--tf-muted)" }}>
        <span>{jobsCompleted} jobs</span>
        <span>{fmtCurrency(avgTicket)} avg</span>
      </div>
    </div>
  );
}

// ─── Styles ──────────────────────────────────────────────────────────────────

const styles: Record<string, React.CSSProperties> = {
  root: {
    width: "100%",
    background: "var(--tf-bg)",
    padding: "32px",
    fontFamily: "Inter, Arial, sans-serif",
  },
  wrap: { maxWidth: "1320px", margin: "0 auto" },

  header: { display: "flex", justifyContent: "space-between", alignItems: "flex-end", gap: "24px", marginBottom: "28px", flexWrap: "wrap" },
  title: { fontFamily: "'Space Grotesk',Inter,Arial,sans-serif", fontSize: "clamp(42px,6vw,76px)", lineHeight: 0.9, letterSpacing: "-0.06em", fontWeight: 900, margin: "0 0 16px", textTransform: "uppercase", color: "var(--tf-text)" },
  headerSubtitle: { borderLeft: "4px solid var(--tf-orange)", paddingLeft: "16px", color: "var(--tf-text-muted)", textTransform: "uppercase", letterSpacing: "0.04em", fontSize: "15px", margin: 0 },
  statusBox: { minWidth: "250px", background: "var(--tf-card)", borderLeft: "1px solid rgba(255,140,0,.35)", padding: "20px" },
  kicker: { display: "block", fontSize: "10px", textTransform: "uppercase", letterSpacing: ".16em", color: "var(--tf-muted)", marginBottom: "6px", fontWeight: 800 },
  liveRow: { display: "flex", alignItems: "center", gap: "8px", fontFamily: "'Space Grotesk',Inter,Arial,sans-serif", fontWeight: 800, textTransform: "uppercase" },
  liveDot: { width: "8px", height: "8px", borderRadius: "50%", background: "var(--tf-orange)", boxShadow: "0 0 18px rgba(255,140,0,.7)" },
  liveText: { fontSize: "14px" },

  scoreboard: { display: "grid", gridTemplateColumns: "repeat(5,1fr)", gap: "16px", marginBottom: "28px", position: "sticky", top: "57px", zIndex: 5, background: "rgba(14,14,14,.92)", backdropFilter: "blur(16px)", padding: "14px 0" },
  scoreCard: { background: "rgba(32,31,31,.96)", border: "1px solid rgba(164,140,122,.16)", borderTop: "2px solid rgba(255,140,0,.6)", padding: "16px", minHeight: "100px", cursor: "help" },
  scoreMain: { background: "linear-gradient(135deg,rgba(255,183,125,.16),rgba(255,140,0,.12))", borderColor: "rgba(255,140,0,.4)" },
  scoreLabel: { display: "block", fontSize: "10px", textTransform: "uppercase", letterSpacing: ".13em", color: "var(--tf-muted)", marginBottom: "10px", fontWeight: 800 },
  scoreValue: { display: "block", fontFamily: "'Space Grotesk',Inter,Arial,sans-serif", fontSize: "clamp(20px,2vw,30px)", fontWeight: 900, letterSpacing: "-.04em", color: "var(--tf-text)" },

  twoCol: { display: "grid", gridTemplateColumns: "repeat(2,1fr)", gap: "24px" },
  twoCol2: { display: "grid", gridTemplateColumns: "repeat(2,1fr)", gap: "24px", marginTop: "24px" },

  card: { background: "rgba(32,31,31,.92)", border: "1px solid rgba(164,140,122,.16)", padding: "28px", boxShadow: "0 18px 60px rgba(0,0,0,.25)" },
  card2: { background: "rgba(28,27,27,.9)", border: "1px solid rgba(164,140,122,.14)", padding: "24px" },

  h3: { fontFamily: "'Space Grotesk',Inter,Arial,sans-serif", margin: 0, letterSpacing: "-.02em", textTransform: "uppercase", fontSize: "20px" },
  h4: { fontFamily: "'Space Grotesk',Inter,Arial,sans-serif", fontSize: "16px", margin: "0 0 14px", paddingLeft: "12px", borderLeft: "4px solid var(--tf-orange)", color: "var(--tf-orange)", textTransform: "uppercase", letterSpacing: "-.02em" },
  num: { width: "32px", height: "32px", display: "inline-flex", alignItems: "center", justifyContent: "center", background: "var(--tf-orange)", color: "#2f1500", fontSize: "12px", fontWeight: 900, borderRadius: "3px" },

  inputGrid: { display: "grid", gridTemplateColumns: "repeat(2,1fr)", gap: "18px 22px" },
  label: { display: "block", fontSize: "10px", textTransform: "uppercase", letterSpacing: ".12em", color: "var(--tf-muted)", marginBottom: "8px", fontWeight: 800, lineHeight: 1.4 },
  input: { width: "100%", background: "#0e0e0e", border: "none", borderBottom: "2px solid rgba(86,67,52,.7)", color: "var(--tf-text)", padding: "12px", outline: "none", fontFamily: "'Space Grotesk',Inter,Arial,sans-serif", fontSize: "18px", fontWeight: 800, borderRadius: 0 },

  resultsGrid: { display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: "16px" },
  resultBox: { background: "var(--tf-card-low)", border: "1px solid rgba(164,140,122,.16)", borderTop: "1px solid rgba(255,140,0,.28)", padding: "18px", cursor: "help", position: "relative" },
  resultLabel: { display: "block", color: "var(--tf-muted)", fontSize: "10px", textTransform: "uppercase", letterSpacing: ".12em", marginBottom: "8px", fontWeight: 800 },
  resultValue: { display: "block", fontFamily: "'Space Grotesk',Inter,Arial,sans-serif", fontWeight: 900, fontSize: "24px", letterSpacing: "-.04em" },

  tableWrap: { overflowX: "auto" },
  table: { width: "100%", borderCollapse: "collapse", minWidth: "980px" },
  th: { textAlign: "left", color: "var(--tf-muted)", fontSize: "10px", textTransform: "uppercase", letterSpacing: ".12em", padding: "12px", borderBottom: "1px solid rgba(164,140,122,.22)", whiteSpace: "nowrap" },
  td: { padding: "10px 12px", borderBottom: "1px solid rgba(164,140,122,.12)", verticalAlign: "middle", color: "var(--tf-text)" },
  tableInput: { background: "#0e0e0e", border: "none", borderBottom: "2px solid rgba(86,67,52,.7)", color: "var(--tf-text)", padding: "8px", outline: "none", fontFamily: "'Space Grotesk',Inter,Arial,sans-serif", fontSize: "15px", fontWeight: 800, borderRadius: 0, minWidth: "92px" },
  tableOutput: { fontFamily: "'Space Grotesk',Inter,Arial,sans-serif", fontWeight: 900, whiteSpace: "nowrap" },
  lockedCell: { minWidth: "92px", padding: "8px", background: "rgba(164,140,122,.08)", border: "1px solid rgba(164,140,122,.18)", color: "var(--tf-muted)", fontFamily: "'Space Grotesk',Inter,Arial,sans-serif", fontSize: "13px", fontWeight: 900, textAlign: "center", letterSpacing: ".08em" },
  pill: { display: "inline-flex", alignItems: "center", justifyContent: "center", minWidth: "90px", padding: "6px 10px", border: "1px solid currentColor", fontFamily: "'Space Grotesk',Inter,Arial,sans-serif", fontSize: "12px", fontWeight: 900, textTransform: "uppercase", letterSpacing: ".06em" },

  insight: { color: "var(--tf-text-muted)", lineHeight: 1.6, margin: 0 },
  note: { color: "var(--tf-muted)", fontSize: "12px", lineHeight: 1.5, marginTop: "14px" },
  printBtn: { border: "none", background: "linear-gradient(135deg,var(--tf-orange-soft),var(--tf-orange))", color: "#2f1500", fontWeight: 900, textTransform: "uppercase", letterSpacing: ".12em", padding: "14px 18px", cursor: "pointer", borderRadius: "3px", marginTop: "16px" },

  disclaimer: { marginTop: "24px", padding: "18px 20px", background: "rgba(32,31,31,.7)", border: "1px solid rgba(164,140,122,.18)", borderLeft: "4px solid rgba(255,140,0,.65)", color: "var(--tf-muted)", fontSize: "11px", lineHeight: 1.6 },
  disclaimerTitle: { display: "block", color: "var(--tf-orange)", fontFamily: "'Space Grotesk',Inter,Arial,sans-serif", fontSize: "12px", textTransform: "uppercase", letterSpacing: ".12em", marginBottom: "6px" },
};