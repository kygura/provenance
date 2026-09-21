import type { NextConfig } from 'next';

/**
 * The workspace packages ship raw TypeScript (`main: ./src/index.ts`), so Next has
 * to compile them rather than treat them as prebuilt dependencies. `@libsql/client`
 * goes the other way: it is a native/server-only driver and must stay external to
 * the server bundle or the build tries to trace its optional bindings.
 */
const nextConfig: NextConfig = {
  transpilePackages: ['@provenance/core', '@provenance/store'],
  serverExternalPackages: ['@libsql/client'],
  // No eslint config lives in this workspace; lint runs from the repo root instead.
  eslint: { ignoreDuringBuilds: true },
  poweredByHeader: false,
  reactStrictMode: true,
};

export default nextConfig;
