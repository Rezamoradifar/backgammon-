import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  turbopack: {
    // RainbowKit's prebuilt bundle statically includes a Base Account
    // (Coinbase Smart Wallet) connector, regardless of which wallets we
    // actually list in lib/wagmi.ts. That connector's SDK references
    // optional `@x402/*` payment sub-packages (both as static imports and
    // as dynamic imports guarding a feature this app never uses) that
    // aren't installed. Aliasing every referenced subpath to an empty
    // module lets the bundler resolve the module graph without pulling in
    // real x402 code that would never execute at runtime anyway.
    resolveAlias: {
      "@x402/core": "./lib/empty-module.js",
      "@x402/core/client": "./lib/empty-module.js",
      "@x402/core/server": "./lib/empty-module.js",
      "@x402/evm": "./lib/empty-module.js",
      "@x402/evm/exact/client": "./lib/empty-module.js",
      "@x402/evm/exact/server": "./lib/empty-module.js",
      "@x402/evm/upto/client": "./lib/empty-module.js",
      "@x402/evm/upto/server": "./lib/empty-module.js",
      "@x402/evm/batch-settlement/server": "./lib/empty-module.js",
      "@x402/svm": "./lib/empty-module.js",
      "@x402/svm/exact/client": "./lib/empty-module.js",
      "@x402/svm/exact/server": "./lib/empty-module.js",
      "@x402/express": "./lib/empty-module.js",
      "@x402/fetch": "./lib/empty-module.js",
      "@x402/extensions/bazaar": "./lib/empty-module.js",
    },
  },
};

export default nextConfig;
