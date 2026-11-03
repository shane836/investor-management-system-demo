import { requireGP } from "@/lib/auth";
import { Topbar } from "@/app/components/Topbar";

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const { profile } = await requireGP();
  return (
    <main className="shell">
      <Topbar isGP name={profile.full_name ?? profile.email} />
      {children}
    </main>
  );
}
