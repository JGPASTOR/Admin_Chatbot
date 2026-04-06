/** @type {import('next').NextConfig} */
const nextConfig = {
  // Enable standalone output for Docker — bundles only what's needed to run
  output: 'standalone',
  reactCompiler: true,
  serverExternalPackages: ['mammoth', 'pdf-parse', 'xlsx'],
};

export default nextConfig;
