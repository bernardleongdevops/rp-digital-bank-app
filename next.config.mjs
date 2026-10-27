/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  experimental: {
    // Enables `instrumentation.ts`, which performs fail-fast environment
    // config validation on server startup (Requirement 7.6, 7.7).
    instrumentationHook: true,
  },
};

export default nextConfig;
