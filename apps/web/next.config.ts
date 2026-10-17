import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // 정적 배포: CloudFront + S3 (아키텍처 기준 G3)
  output: "export",
  // 페이지별 폴더/index.html 생성 (S3 경로 직접 매핑)
  trailingSlash: true,
};

export default nextConfig;
