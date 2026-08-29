import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["@coinbase/cdp-sdk", "@base-org/account"],
  turbopack: {
    resolveAlias: {
      "@x402/core/client": "./empty-module.ts",
    },
  },
};

export default nextConfig;
