import type { NextConfig } from 'next';

// Internal backend URL for rewrites — never use the public URL here to avoid loops
const BACKEND_URL = process.env.BACKEND_INTERNAL_URL || 'http://localhost:4000';

const nextConfig: NextConfig = {
  output: 'standalone',
  // Proxy backend routes so a single port (3000) can serve everything
  async rewrites() {
    return [
      { source: '/api/:path*', destination: `${BACKEND_URL}/api/:path*` },
      { source: '/health', destination: `${BACKEND_URL}/health` },
      { source: '/health/:path*', destination: `${BACKEND_URL}/health/:path*` },
      { source: '/mcp', destination: `${BACKEND_URL}/mcp` },
      { source: '/mcp/:path*', destination: `${BACKEND_URL}/mcp/:path*` },
      { source: '/.well-known/:path*', destination: `${BACKEND_URL}/.well-known/:path*` },
      { source: '/authorize', destination: `${BACKEND_URL}/authorize` },
      { source: '/token', destination: `${BACKEND_URL}/token` },
      { source: '/register', destination: `${BACKEND_URL}/register` },
    ];
  },
};

export default nextConfig;
