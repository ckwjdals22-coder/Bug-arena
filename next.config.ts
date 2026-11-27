import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  poweredByHeader: false,
  reactStrictMode: true,
  // Docker 배포용 독립 실행 번들(.next/standalone)
  output: "standalone",
  experimental: {
    serverActions: {
      // 이미지 업로드(최대 5MB) 여유분
      bodySizeLimit: "6mb",
    },
  },
};

export default nextConfig;
