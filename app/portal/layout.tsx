import { requireUser } from "@/lib/auth";
import { Topbar } from "@/app/components/Topbar";

export default async function PortalLayout({ children }: { children: React.ReactNode }) {
  const { profile } = await requireUser();
  return (
    <main className="shell">
      <Topbar isGP={profile.role === "gp"} name={profile.full_name ?? profile.email} />
      {children}
    </main>
  );
}
