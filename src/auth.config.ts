import type { NextAuthConfig } from "next-auth";

// Edge-safe config — no Prisma, no Node.js-only modules.
// Used by both proxy.ts (Edge Runtime) and auth.ts (Node.js runtime).
export const authConfig = {
  pages: {
    signIn: "/login",
    error: "/login",
  },
  session: { strategy: "jwt" as const },
  callbacks: {
    authorized({ auth, request: { nextUrl } }) {
      const isLoggedIn = !!auth?.user;
      const PUBLIC = ["/login", "/signup", "/api/auth", "/demo"];
      const isPublic = PUBLIC.some((p) => nextUrl.pathname.startsWith(p));
      if (!isLoggedIn && !isPublic) return false;
      if (isLoggedIn && (nextUrl.pathname === "/login" || nextUrl.pathname === "/signup")) {
        return Response.redirect(new URL("/", nextUrl));
      }
      return true;
    },
    jwt({ token, user }: any) {
      if (user) {
        token.id = user.id;
        token.tenantId = user.tenantId;
        token.tenantName = user.tenantName;
        token.role = user.role;
      }
      return token;
    },
    session({ session, token }: any) {
      session.user.id = token.id;
      session.user.tenantId = token.tenantId;
      session.user.tenantName = token.tenantName;
      session.user.role = token.role;
      return session;
    },
  },
  providers: [],
} satisfies NextAuthConfig;