// All formulas ported directly from Titan Daily Command Board V4.1.html
// Treat the original HTML as regression baseline — outputs must match exactly.

export interface BoardInputs {
  monthlyRevenueGoal: number;
  monthlySoldHourGoal: number;
  workingDaysMonth: number;
  workingDaysLeftMonth: number;
  weeklyRevenueGoal: number;
  weeklySoldHourGoal: number;
  workingDaysLeftWeek: number;
  mtdRevenue: number;
  wtdRevenue: number;
  yesterdayRevenue: number;
  totalMtdCalls: number;
  mtdSoldHours: number;
  todayOpportunities: number;
  techsAvailableToday: number;
  avgSoldHoursPerTech: number;
  // Install board (HVAC only)
  installCrews?: number;
  installRevenue?: number;
  daysBookedOut?: number;
  equipmentSalesRevenue?: number;
}

export interface UnitInputs {
  name: string;
  mtdOpps: number;
  targetCloseRate: number;
  actualCloseRate: number;
  mtdSales: number;
  prevSoldToday: number;
  targetRpl: number;
  includesInstall?: boolean;
}

export interface UnitOutputs {
  actualRpl: number;
  closedJobs: number;
  avgSale: number;
  monthlyPace: number;
  signal: "On Track" | "Watch" | "Behind";
  closeGood: boolean;
  rplGood: boolean;
}

export interface BoardOutputs {
  // Scoreboard
  dailyCommandGoal: number;
  revenueNeededToday: number;
  weeklyNeededToday: number;
  soldHoursNeeded: number;
  // Section 03
  companyRpl: number;
  companyAvgSale: number;
  totalPrevSold: number;
  newRevenueNeeded: number;
  leadsNeeded: number;
  salesNeeded: number;
  techCapacityToday: number;
  capacityOk: boolean;
  avgTicketNeeded: number;
  revenueGap: number;
  monthlyPace: number;
  signal: "Attackable" | "Heavy Push" | "Needs More Leads" | "Review";
  // Table totals
  totalOpps: number;
  totalClose: number;
  totalSales: number;
  totalRpl: number;
  totalClosed: number;
  totalAvgSale: number;
  totalPace: number;
  // Install board
  installRevenuePending: number;
  installInsight: string;
  // Insight paragraph
  insightText: string;
}

function safe(n: number): number {
  return isFinite(n) ? n : 0;
}

export function calculateUnit(inputs: UnitInputs, daysElapsed: number): UnitOutputs {
  const { mtdOpps, targetCloseRate, actualCloseRate, mtdSales, targetRpl } = inputs;
  const closedJobs = Math.round(mtdOpps * (actualCloseRate / 100));
  const actualRpl = mtdOpps > 0 ? safe(mtdSales / mtdOpps) : 0;
  const avgSale = closedJobs > 0 ? safe(mtdSales / closedJobs) : 0;
  const monthlyPace = safe(mtdSales / daysElapsed);
  const closeGood = actualCloseRate >= targetCloseRate;
  const rplGood = actualRpl >= targetRpl;
  const watch = closeGood || rplGood;
  const signal: UnitOutputs["signal"] =
    closeGood && rplGood ? "On Track" : watch ? "Watch" : "Behind";
  return { actualRpl, closedJobs, avgSale, monthlyPace, signal, closeGood, rplGood };
}

export function calculateBoard(
  inputs: BoardInputs,
  units: UnitInputs[]
): BoardOutputs {
  const {
    monthlyRevenueGoal, monthlySoldHourGoal,
    workingDaysMonth, workingDaysLeftMonth,
    weeklyRevenueGoal, workingDaysLeftWeek,
    mtdRevenue, wtdRevenue, totalMtdCalls, mtdSoldHours,
    todayOpportunities, techsAvailableToday, avgSoldHoursPerTech,
    installCrews = 0, installRevenue = 0, daysBookedOut = 0,
    equipmentSalesRevenue = 0,
  } = inputs;

  const daysElapsedMonth = Math.max(1, workingDaysMonth - workingDaysLeftMonth);
  const safeDaysLeftMonth = Math.max(1, workingDaysLeftMonth);
  const safeDaysLeftWeek = Math.max(1, workingDaysLeftWeek);

  const revenueNeededToday = Math.max(0, (monthlyRevenueGoal - mtdRevenue) / safeDaysLeftMonth);
  const weeklyNeededToday = Math.max(0, (weeklyRevenueGoal - wtdRevenue) / safeDaysLeftWeek);
  const dailyCommandGoal = Math.max(revenueNeededToday, weeklyNeededToday);
  const soldHoursNeeded = Math.max(0, (monthlySoldHourGoal - mtdSoldHours) / safeDaysLeftMonth);
  const techCapacityToday = techsAvailableToday * avgSoldHoursPerTech;
  const monthlyPace = safe(mtdRevenue / daysElapsedMonth);
  const revenueGap = mtdRevenue - (monthlyRevenueGoal / workingDaysMonth) * daysElapsedMonth;
  const companyRpl = totalMtdCalls > 0 ? safe(mtdRevenue / totalMtdCalls) : 0;

  // Aggregate unit data
  let totalOpps = 0;
  let totalSales = 0;
  let totalClosed = 0;
  let totalPace = 0;
  let totalPrevSold = 0;

  for (const unit of units) {
    const out = calculateUnit(unit, daysElapsedMonth);
    totalOpps += unit.mtdOpps;
    totalSales += unit.mtdSales;
    totalPrevSold += unit.prevSoldToday;
    totalClosed += out.closedJobs;
    totalPace += out.monthlyPace;
  }

  const newRevenueNeeded = Math.max(0, dailyCommandGoal - totalPrevSold);
  const companyAvgSale = totalClosed > 0 ? safe(totalSales / totalClosed) : 0;
  const salesNeeded = companyAvgSale > 0 ? Math.ceil(newRevenueNeeded / companyAvgSale) : 0;
  const leadsNeeded = companyRpl > 0 ? Math.ceil(newRevenueNeeded / companyRpl) : 0;
  const avgTicketNeeded = todayOpportunities > 0 ? safe(newRevenueNeeded / todayOpportunities) : 0;
  const capacityOk = techCapacityToday >= soldHoursNeeded;
  const totalClose = totalOpps > 0 ? (totalClosed / totalOpps) * 100 : 0;
  const totalRpl = totalOpps > 0 ? safe(totalSales / totalOpps) : 0;
  const totalAvgSale = totalClosed > 0 ? safe(totalSales / totalClosed) : 0;

  const closingNeeded = todayOpportunities > 0 ? (salesNeeded / todayOpportunities) * 100 : 0;
  let signal: BoardOutputs["signal"] = "Review";
  if (dailyCommandGoal > 0) {
    if (closingNeeded <= 50) signal = "Attackable";
    else if (closingNeeded <= 80) signal = "Heavy Push";
    else signal = "Needs More Leads";
  }

  // Install board
  const installRevenuePending = Math.max(0, equipmentSalesRevenue - installRevenue);
  let installInsight = `Install operations currently have ${installCrews} crews active today. MTD invoiced install revenue is ${fmt(installRevenue)} with approximately ${fmt(installRevenuePending)} still pending in backlog from equipment sales.`;
  if (daysBookedOut > 10) {
    installInsight += " The install board is heavily booked out. Sales may be outrunning fulfillment capacity.";
  } else {
    installInsight += " Install backlog appears stable relative to current workload.";
  }

  // Foundry Insight
  let insightText = `Today's command goal is ${fmt(dailyCommandGoal)}. Previously sold work scheduled for completion today covers ${fmt(totalPrevSold)}, leaving ${fmt(newRevenueNeeded)} in new revenue to create. That means the team needs roughly ${leadsNeeded} leads, ${salesNeeded} closed sales, and an average ticket of ${fmt(avgTicketNeeded)} across today's opportunities. Available tech capacity is ${techCapacityToday.toFixed(1)} sold hours against a need of ${soldHoursNeeded.toFixed(1)} sold hours.`;
  if (!capacityOk) {
    insightText += " Capacity is the constraint. Either increase available field capacity, prioritize higher-value calls, or reduce low-value work on the board.";
  } else if (signal === "Needs More Leads") {
    insightText += " Opportunity count is the constraint. The priority should be dispatching more revenue opportunity, rehashing open estimates, or adding same-day demand.";
  } else if (signal === "Heavy Push") {
    insightText += " This is possible, but it needs focused dispatching, strong option presentation, and active estimate follow-up.";
  } else {
    insightText += " This is an attackable daily target. Keep the team focused on average ticket, close rate, and sold-hour capture.";
  }

  return {
    dailyCommandGoal, revenueNeededToday, weeklyNeededToday, soldHoursNeeded,
    companyRpl, companyAvgSale, totalPrevSold, newRevenueNeeded,
    leadsNeeded, salesNeeded, techCapacityToday, capacityOk,
    avgTicketNeeded, revenueGap, monthlyPace,
    signal, totalOpps, totalClose, totalSales, totalRpl,
    totalClosed, totalAvgSale, totalPace,
    installRevenuePending, installInsight, insightText,
  };
}

function fmt(val: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency", currency: "USD", maximumFractionDigits: 0,
  }).format(safe(val));
}