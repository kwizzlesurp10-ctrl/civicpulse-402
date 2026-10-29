/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  async rewrites() {
    return [
      {
        source: '/api/x402-bazaar/:path*',
        destination: 'https://x402-mcp.onrender.com/:path*',
      },
    ];
  },
};
export default nextConfig;
