// Formula regression test — inputs match HTML defaults, expected outputs
// computed by manually tracing the original HTML JavaScript.
import { calculateBoard, calculateUnit } from "./calculations";

const DEFAULT_INPUTS = {
  monthlyRevenueGoal: 179000,
  monthlySoldHourGoal: 1134,
  workingDaysMonth: 20,
  workingDaysLeftMonth: 16,
  weeklyRevenueGoal: 44750,
  weeklySoldHourGoal: 284,
  workingDaysLeftWeek: 2,
  mtdRevenue: 39000,
  wtdRevenue: 16000,
  yesterdayRevenue: 4000,
  totalMtdCalls: 32,
  mtdSoldHours: 122,
  todayOpportunities: 4,
  techsAvailableToday: 5,
  avgSoldHoursPerTech: 5,
  installCrews: 2,
  installRevenue: 25000,
  daysBookedOut: 7,
  equipmentSalesRevenue: 39016,
};

const DEFAULT_UNITS = [
  { name: "Maintenance",    mtdOpps: 15, targetCloseRate: 65, actualCloseRate: 33, mtdSales: 5698,  prevSoldToday: 0, targetRpl: 454 },
  { name: "Demand Service", mtdOpps: 9,  targetCloseRate: 50, actualCloseRate: 44, mtdSales: 39016, prevSoldToday: 0, targetRpl: 1100 },
  { name: "Equipment Sales",mtdOpps: 8,  targetCloseRate: 50, actualCloseRate: 38, mtdSales: 39016, prevSoldToday: 0, targetRpl: 12000, includesInstall: true },
];

function approx(a: number, b: number, tol = 0.01) {
  return Math.abs(a - b) <= tol;
}

function assert(label: string, got: number | string | boolean, want: number | string | boolean, tol?: number) {
  const ok = typeof want === "number" && typeof got === "number"
    ? approx(got, want, tol ?? 0.01)
    : got === want;
  const status = ok ? "✓" : "✗ FAIL";
  console.log(`  ${status}  ${label}: got=${got}, want=${want}`);
  if (!ok) process.exitCode = 1;
}

// ── Unit outputs (daysElapsed = 20 - 16 = 4) ─────────────────────────────────

const daysElapsed = 4;
console.log("\nUnit: Maintenance");
const m = calculateUnit(DEFAULT_UNITS[0], daysElapsed);
assert("closedJobs",   m.closedJobs,   5);           // round(15 * 0.33) = round(4.95) = 5
assert("actualRpl",    m.actualRpl,    379.87, 0.1);  // 5698/15
assert("avgSale",      m.avgSale,      1139.6, 0.1);  // 5698/5
assert("monthlyPace",  m.monthlyPace,  1424.5, 0.1);  // 5698/4
assert("closeGood",    m.closeGood,    false);
assert("rplGood",      m.rplGood,      false);
assert("signal",       m.signal,       "Behind");

console.log("\nUnit: Demand Service");
const d = calculateUnit(DEFAULT_UNITS[1], daysElapsed);
assert("closedJobs",   d.closedJobs,   4);             // round(9 * 0.44) = round(3.96) = 4
assert("actualRpl",    d.actualRpl,    4335.11, 0.1);  // 39016/9
assert("avgSale",      d.avgSale,      9754, 0.1);     // 39016/4
assert("monthlyPace",  d.monthlyPace,  9754, 0.1);     // 39016/4
assert("closeGood",    d.closeGood,    false);         // 44 < 50
assert("rplGood",      d.rplGood,      true);          // 4335 >= 1100
assert("signal",       d.signal,       "Watch");

console.log("\nUnit: Equipment Sales");
const e = calculateUnit(DEFAULT_UNITS[2], daysElapsed);
assert("closedJobs",   e.closedJobs,   3);             // round(8 * 0.38) = round(3.04) = 3
assert("actualRpl",    e.actualRpl,    4877, 0.5);     // 39016/8
assert("avgSale",      e.avgSale,      13005.33, 0.1); // 39016/3
assert("signal",       e.signal,       "Behind");

// ── Board outputs ─────────────────────────────────────────────────────────────

console.log("\nBoard");
const b = calculateBoard(DEFAULT_INPUTS, DEFAULT_UNITS);
assert("dailyCommandGoal",   b.dailyCommandGoal,   14375);     // max(8750, 14375)
assert("revenueNeededToday", b.revenueNeededToday, 8750);      // (179000-39000)/16
assert("weeklyNeededToday",  b.weeklyNeededToday,  14375);     // (44750-16000)/2
assert("soldHoursNeeded",    b.soldHoursNeeded,    63.25);     // (1134-122)/16
assert("companyRpl",         b.companyRpl,         1218.75);   // 39000/32
assert("totalSales",         b.totalSales,         83730);     // 5698+39016+39016
assert("totalOpps",          b.totalOpps,          32);        // 15+9+8
assert("totalClosed",        b.totalClosed,        12);        // 5+4+3
assert("companyAvgSale",     b.companyAvgSale,     6977.5, 0.1); // 83730/12
assert("newRevenueNeeded",   b.newRevenueNeeded,   14375);     // max(0, 14375-0)
assert("salesNeeded",        b.salesNeeded,        3);         // ceil(14375/6977.5)
assert("leadsNeeded",        b.leadsNeeded,        12);        // ceil(14375/1218.75)
assert("avgTicketNeeded",    b.avgTicketNeeded,    3593.75);   // 14375/4
assert("capacityOk",         b.capacityOk,         false);     // 25 < 63.25
assert("revenueGap",         b.revenueGap,         3200);      // 39000 - (179000/20*4)
assert("monthlyPace",        b.monthlyPace,        9750);      // 39000/4
assert("signal",             b.signal,             "Heavy Push"); // closingNeeded = 75%
assert("installRevenuePending", b.installRevenuePending, 14016); // 39016-25000

console.log("\nDone.\n");