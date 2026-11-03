import type { NextConfig } from "next";

// 운영자 사이트 (BRD-147, 아키텍처 18.7). 사용자 사이트와 따로 배포하는 정적 사이트
// 화면 파일에는 데이터·비밀값을 넣지 않고, 데이터는 로그인 뒤 운영 API(/ops/*)로만 받음
const nextConfig: NextConfig = {
  // 정적 배포: CloudFront + S3 (G3). 서버 실행 기능(Server Action·Route Handler·ISR·Proxy)은 쓰지 않음
  output: "export",
  // 페이지별 폴더/index.html 생성 (S3 경로 직접 매핑)
  trailingSlash: true,
};

export default nextConfig;
