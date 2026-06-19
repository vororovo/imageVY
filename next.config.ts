import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* 기존에 있던 다른 설정들... */
  
  // 빌드 시 ESLint 경고/에러가 있어도 배포를 진행하도록 설정
  eslint: {
    ignoreDuringBuilds: true,
  },
  // 혹시 모를 TypeScript 타입 경고도 넘어가고 싶다면 아래 줄도 추가 가능합니다.
  typescript: {
    ignoreBuildErrors: true,
  }
};

export default nextConfig;
