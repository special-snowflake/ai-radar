import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The radar runs a background scanner inside the Node.js server process
  // (see src/instrumentation.ts), so keep the instrumentation hook enabled.
  serverExternalPackages: ["fast-xml-parser"],
  experimental: {
    // Server Actions + route handlers stream a lot of small JSON payloads.
    optimizePackageImports: [],
  },
};

export default nextConfig;
