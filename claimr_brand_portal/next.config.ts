import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: 'export',
  basePath: '/brand',
  images: {
    unoptimized: true,
  },
  transpilePackages: ['react-map-gl', 'mapbox-gl'],
  webpack: (config) => {
    config.resolve.alias = {
      ...config.resolve.alias,
      'mapbox-gl': 'mapbox-gl/dist/mapbox-gl.js',
    };
    return config;
  },
};

export default nextConfig;
