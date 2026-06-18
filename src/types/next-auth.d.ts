import "next-auth";

declare module "next-auth" {
  interface User {
    tenantId: string;
    tenantName: string;
    role: string;
  }
  interface Session {
    user: {
      id: string;
      email: string;
      name: string;
      tenantId: string;
      tenantName: string;
      role: string;
    };
  }
}