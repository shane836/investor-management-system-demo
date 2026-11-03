import Link from "next/link";
import { FIRM } from "@/lib/util";
import { signOut } from "@/app/login/actions";

export function Topbar({ isGP, name }: { isGP: boolean; name: string }) {
  return (
    <header className="topbar">
      <Link href="/" className="brand">
        {FIRM}
      </Link>
      <nav className="nav">
        <Link href="/portal">Portfolio</Link>
        {isGP && <Link href="/admin">Admin</Link>}
        <span className="muted small">{name}</span>
        <form action={signOut}>
          <button className="link" type="submit">
            Sign out
          </button>
        </form>
      </nav>
    </header>
  );
}

export function Flash({ searchParams }: { searchParams: Record<string, string | undefined> }) {
  if (searchParams.error) return <div className="notice bad">{searchParams.error}</div>;
  if (searchParams.ok) return <div className="notice ok">{searchParams.ok}</div>;
  return null;
}

const TONE: Record<string, string> = {
  funded: "ok",
  verified: "ok",
  funding: "warn",
  documents: "warn",
  accreditation: "warn",
  pending: "warn",
  rejected: "bad",
  withdrawn: "bad",
  open: "ok",
  draft: "warn",
};

export function Badge({ value, label }: { value: string; label?: string }) {
  return <span className={`badge ${TONE[value] ?? ""}`}>{label ?? value}</span>;
}
