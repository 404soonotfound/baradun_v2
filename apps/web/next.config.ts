import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";

// 문구 키: 요청 설정 파일 위치를 알려 줘요 (BRD-22)
const withNextIntl = createNextIntlPlugin("./src/i18n/request.ts");

const nextConfig: NextConfig = {
  // 정적 배포: CloudFront + S3 (아키텍처 기준 G3)
  output: "export",
  // 페이지별 폴더/index.html 생성 (S3 경로 직접 매핑)
  trailingSlash: true,
  experimental: {
    // 루트 레이아웃이 언어별로 둘이라 전역 404 파일 사용 (BRD-47)
    globalNotFound: true,
  },
};

export default withNextIntl(nextConfig);
