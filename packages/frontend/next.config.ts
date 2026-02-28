import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  output: 'standalone',
  // API calls proxy to backend in Docker
  async rewrites() {
    return [
      {
        source: '/api/:path*',
        destination: `${process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000'}/api/:path*`,
      },
    ];
  },
};

export default nextConfig;
