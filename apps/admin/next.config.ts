import { execFileSync } from "node:child_process";
import type { NextConfig } from "next";

// 운영자 사이트 (BRD-147, 아키텍처 18.7). 사용자 사이트와 따로 배포하는 정적 사이트
// 화면 파일에는 데이터·비밀값을 넣지 않고, 데이터는 로그인 뒤 운영 API(/ops/*)로만 받음

// 왼쪽 메뉴 아래 '운영 화면 11/3 · a1b2c3d'(GH-450, 시안 V1). 빌드한 커밋의 날짜(KST)와 짧은 해시
// 빌드 시각이 아니라 커밋 값이라 같은 커밋은 같은 결과. git을 못 읽으면 빈 값 → 화면은 '버전 확인 못 함'
function buildVersion(): { date: string; sha: string } {
  try {
    const [sha, committed] = execFileSync(
      "git",
      ["log", "-1", "--format=%h%n%cI"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    )
      .trim()
      .split("\n");
    const at = new Date(Date.parse(committed ?? "") + 9 * 3_600_000);
    if (!sha || Number.isNaN(at.getTime())) return { date: "", sha: "" };
    return {
      date: `${at.getUTCMonth() + 1}/${at.getUTCDate()}`,
      sha: sha.slice(0, 7),
    };
  } catch {
    return { date: "", sha: "" };
  }
}

const version = buildVersion();

const nextConfig: NextConfig = {
  // 정적 배포: CloudFront + S3 (G3). 서버 실행 기능(Server Action·Route Handler·ISR·Proxy)은 쓰지 않음
  output: "export",
  // 페이지별 폴더/index.html 생성 (S3 경로 직접 매핑)
  trailingSlash: true,
  // 공개해도 되는 값만(커밋 날짜·해시). 비밀값을 넣지 않음
  env: {
    ADMIN_VERSION_DATE: version.date,
    ADMIN_VERSION_SHA: version.sha,
  },
};

export default nextConfig;
