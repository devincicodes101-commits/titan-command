import { NextRequest, NextResponse } from "next/server";
import NextAuth from "next-auth";
import { authConfig } from "@/auth.config";

const { auth } = NextAuth(authConfig);

const PUBLIC_PATHS = ["/login", "/signup", "/api/auth", "/demo", "/forgot-password", "/reset-password"];

export default auth((request) => {
  const { pathname } = request.nextUrl;

  // Public paths pass through with no auth check
  if (PUBLIC_PATHS.some((p) => pathname.startsWith(p))) {
    return NextResponse.next();
  }

  // Not authenticated → send to login
  if (!request.auth) {
    return NextResponse.redirect(new URL("/login", request.url));
  }

  // Authenticated user hitting login/signup → send to dashboard
  if (pathname === "/login" || pathname === "/signup") {
    return NextResponse.redirect(new URL("/", request.url));
  }

  return NextResponse.next();
});

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};