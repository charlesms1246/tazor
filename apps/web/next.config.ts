import type { NextConfig } from 'next';

const config: NextConfig = {
  output: 'export',
  trailingSlash: true,
  images: { unoptimized: true },
  generateBuildId: async () => `tazor-${(process.env.NEXT_PUBLIC_BUILD_TIME || 'unversioned').replace(/[^0-9A-Za-z]/g, '')}`,
};

export default config;
