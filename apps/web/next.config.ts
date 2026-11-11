import type { NextConfig } from "next";
import { PHASE_DEVELOPMENT_SERVER } from "next/constants";
import createNextIntlPlugin from "next-intl/plugin";

import { devMapOrigin } from "./scripts/dev-map.mjs";

// 문구 키: 요청 설정 파일 위치를 알려 줌 (BRD-22)
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

// 개발 서버(next dev)에서만 지도 판 파일 /map/을 운영 CloudFront로 넘김(scripts/dev-map.mjs, D19-1)
// 정적 내보내기는 rewrites를 쓰지 않으므로 빌드(next build) 설정에는 넣지 않음
// next dev 시작 때 나오는 'Specified "rewrites" will not automatically work with "output: export"' 경고는
// 정적 내보내기에 대한 안내라 예상된 것. 개발 서버에서는 이 rewrite가 동작함
export default function config(phase: string): NextConfig {
  if (phase !== PHASE_DEVELOPMENT_SERVER) return withNextIntl(nextConfig);
  const origin = devMapOrigin();
  return withNextIntl({
    ...nextConfig,
    rewrites: async () => [
      { source: "/map/:path*", destination: `${origin}/map/:path*` },
    ],
  });
}
