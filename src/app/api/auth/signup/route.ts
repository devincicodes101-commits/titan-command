import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import bcrypt from "bcryptjs";

export async function POST(req: NextRequest) {
  try {
    const { companyName, email, password } = await req.json();

    if (!companyName || !email || !password) {
      return NextResponse.json({ error: "All fields required." }, { status: 400 });
    }
    if (password.length < 8) {
      return NextResponse.json({ error: "Password must be at least 8 characters." }, { status: 400 });
    }

    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) {
      return NextResponse.json({ error: "An account with that email already exists." }, { status: 409 });
    }

    const slug = companyName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 48);

    const uniqueSlug = await makeSlugUnique(slug);
    const passwordHash = await bcrypt.hash(password, 12);

    await prisma.tenant.create({
      data: {
        name: companyName,
        slug: uniqueSlug,
        users: {
          create: { email, passwordHash, role: "OWNER" },
        },
        goals: {
          create: {},
        },
        crmCredentials: {
          create: { provider: "MANUAL" },
        },
        businessUnits: {
          create: defaultBusinessUnits(),
        },
      },
    });

    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error(err);
    return NextResponse.json({ error: "Server error." }, { status: 500 });
  }
}

async function makeSlugUnique(base: string): Promise<string> {
  let slug = base;
  let i = 1;
  while (await prisma.tenant.findUnique({ where: { slug } })) {
    slug = `${base}-${i++}`;
  }
  return slug;
}

function defaultBusinessUnits() {
  return [
    { sortOrder: 0, name: "Maintenance", targetCloseRate: 65, targetRpl: 454 },
    { sortOrder: 1, name: "Demand Service", targetCloseRate: 50, targetRpl: 1100 },
    { sortOrder: 2, name: "Equipment Sales", targetCloseRate: 50, targetRpl: 12000, includesInstall: true },
  ];
}