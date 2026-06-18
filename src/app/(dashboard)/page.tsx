import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import CommandBoard from "@/components/CommandBoard";

export default async function DashboardPage() {
  const session = await auth();
  if (!session) return null;

  const [goals, businessUnits, tenant] = await Promise.all([
    prisma.tenantGoals.findUnique({ where: { tenantId: session.user.tenantId } }),
    prisma.businessUnit.findMany({
      where: { tenantId: session.user.tenantId },
      orderBy: { sortOrder: "asc" },
    }),
    prisma.tenant.findUnique({ where: { id: session.user.tenantId } }),
  ]);

  const tradeMap: Record<string, string> = {
    HVAC: "HVAC", PLUMBING: "Plumbing", ELECTRICAL: "Electrical",
    SOLAR: "Solar", GARAGE_DOORS: "Garage Doors", ROOFING: "Roofing",
    POOLS: "Pools", LANDSCAPE: "Landscape", OTHER: "Other",
  };

  const savedGoals = goals
    ? {
        monthlyRevenueGoal: goals.monthlyRevenueGoal,
        monthlySoldHourGoal: goals.monthlySoldHourGoal,
        weeklyRevenueGoal: goals.weeklyRevenueGoal,
        weeklySoldHourGoal: goals.weeklySoldHourGoal,
        workingDaysMonth: goals.workingDaysMonth,
        trade: (tradeMap[tenant?.trade ?? "HVAC"] ?? "HVAC") as any,
        businessUnits: businessUnits.map((u) => ({
          name: u.name,
          targetCloseRate: u.targetCloseRate,
          targetRpl: u.targetRpl,
          includesInstall: u.includesInstall,
        })),
      }
    : null;

  return <CommandBoard savedGoals={savedGoals} />;
}