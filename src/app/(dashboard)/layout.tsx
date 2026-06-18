import { auth } from "@/auth";
import { redirect } from "next/navigation";
import TopNav from "@/components/TopNav";

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const session = await auth();
  if (!session) redirect("/login");

  return (
    <>
      <TopNav tenantName={session.user.tenantName} userEmail={session.user.email} />
      <main style={{ flex: 1 }}>{children}</main>
    </>
  );
}