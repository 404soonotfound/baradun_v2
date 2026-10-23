import { OBSERVATION_POLICY } from "../core/observations/policy";
import { WARNING_POLICY } from "../core/warnings/policy";

// 게시 정책값 (아키텍처 6.2·6.3·11장, BRD-61)
// 숫자를 코드 곳곳에 두지 않고 여기 한 곳에만 둠
// manifest 설정(점검·최소 화면 버전)은 저장소에서 바꿔 배포하면 반영됨(아키텍처 9.1, 2026-10-23 사용자 결정)

const MINUTE_MS = 60 * 1000;

export const PUBLISH_POLICY = {
  // 분류 규칙 버전 = 특보·관측 정책 버전. 어느 쪽이든 값을 바꾸면 그쪽 version을 올림(14.3)
  policyVersion: `${WARNING_POLICY.version}+${OBSERVATION_POLICY.version}`,
  // 게시 잠금(아키텍처 6.2: 연속 호출은 하나만 실행). Ops 키 lock#{name}
  lockName: "publish-snapshot",
  // Lambda 시간 제한(PR ② infra)보다 길게. 끝나면 바로 풀고, 실행이 죽으면 이 시간 뒤 다음 실행이 맡음
  lockTtlMs: 2 * MINUTE_MS,
  // 최근 48개 버전 보존(롤백용, 아키텍처 6.2)
  retainVersions: 48,
  // 11장 10/19: CloudFront 기본 정책은 헤더가 없으면 하루 캐시함 → 모든 파일에 붙임
  cacheControl: {
    manifest: "public, max-age=60",
    versioned: "public, max-age=31536000, immutable",
  },
} as const;

export const MANIFEST_SETTINGS = {
  schemaVersion: 1,
  // 점검 중이면 active: true, until: 종료 예정(UTC ISO, 모르면 null)
  maintenance: { active: false, until: null },
  // 이보다 낮은 화면 버전은 강제 업데이트(BRD-43)
  minWebBuild: 1,
} as const;
