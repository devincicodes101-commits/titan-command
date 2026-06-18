import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";

export async function GET() {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const [goals, units, tenant] = await Promise.all([
    prisma.tenantGoals.findUnique({ where: { tenantId: session.user.tenantId } }),
    prisma.businessUnit.findMany({
      where: { tenantId: session.user.tenantId },
      orderBy: { sortOrder: "asc" },
    }),
    prisma.tenant.findUnique({ where: { id: session.user.tenantId } }),
  ]);

  return NextResponse.json({ goals, units, trade: tenant?.trade });
}

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { goals, units, trade } = await req.json();

  await prisma.$transaction([
    prisma.tenantGoals.upsert({
      where: { tenantId: session.user.tenantId },
      update: goals,
      create: { ...goals, tenantId: session.user.tenantId },
    }),
    prisma.tenant.update({
      where: { id: session.user.tenantId },
      data: { trade },
    }),
    prisma.businessUnit.deleteMany({ where: { tenantId: session.user.tenantId } }),
    prisma.businessUnit.createMany({
      data: units.map((u: any, i: number) => ({
        ...u,
        tenantId: session.user.tenantId,
        sortOrder: i,
      })),
    }),
  ]);

  return NextResponse.json({ ok: true });
}