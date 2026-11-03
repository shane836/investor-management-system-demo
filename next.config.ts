import type { NextConfig } from "next";
import { PHASE_DEVELOPMENT_SERVER } from "next/constants";

const nextConfig = (phase: string): NextConfig => ({
  // Builds must not replace chunks used by a running development server.
  distDir: phase === PHASE_DEVELOPMENT_SERVER ? ".next-dev" : ".next",
  // Accreditation letters & signed sub docs are uploaded through server actions.
  experimental: { serverActions: { bodySizeLimit: "15mb" } },
});

export default nextConfig;
