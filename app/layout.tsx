import type { Metadata } from "next";
import "./globals.css";
import { FIRM } from "@/lib/util";

export const metadata: Metadata = {
  title: `${FIRM} — Investor Portal`,
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
