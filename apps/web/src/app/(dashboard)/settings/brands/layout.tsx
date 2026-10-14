import { redirect } from "next/navigation";
import { getDashboardRole, requireDashboardSession } from "@/lib/session";

export default async function BrandsLayout({ children }: { children: React.ReactNode }) {
  const session = await requireDashboardSession();
  if (getDashboardRole(session) !== "admin") redirect("/dashboard");
  return children;
}
