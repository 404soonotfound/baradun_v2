import { POLICY_VERSION } from "@baradun/contracts/judgment-policy";

// 게시 정책값 (아키텍처 6.2·6.3·11장, BRD-61)
// 숫자를 코드 곳곳에 두지 않고 여기 한 곳에만 둠
// manifest 설정(점검·최소 화면 버전)은 저장소에서 바꿔 배포하면 반영됨(아키텍처 9.1, 2026-10-23 사용자 결정)

const MINUTE_MS = 60 * 1000;

export const PUBLISH_POLICY = {
  // 분류 규칙 버전 = 특보·관측 정책 버전(14.3). 계약 패키지가 원본(D20-5), 웹은 모르는 버전을 판단불가로 봄(D20-6)
  policyVersion: POLICY_VERSION,
  // 게시 잠금(아키텍처 6.2: 연속 호출은 하나만 실행). Ops 키 lock#{name}
  lockName: "publish-snapshot",
  // Lambda 시간 제한(PR ② infra)보다 길게. 끝나면 바로 풀고, 실행이 죽으면 이 시간 뒤 다음 실행이 맡음
  lockTtlMs: 2 * MINUTE_MS,
  // 최근 48개 버전 보존(롤백용, 아키텍처 6.2)
  retainVersions: 48,
  // manifest 조건부 쓰기 시도 횟수. 다른 실행이 끼어들어 거절되면 다시 읽고 판단함
  // 끼어든 쪽이 더 새 버전이면 첫 재시도에서 version_not_newer로 끝나므로 3번이면 충분
  manifestWriteAttempts: 3,
  // 11장 10/19: CloudFront 기본 정책은 헤더가 없으면 하루 캐시함 → 모든 파일에 붙임
  cacheControl: {
    manifest: "public, max-age=60",
    versioned: "public, max-age=31536000, immutable",
  },
  // 날씨(weather.json, BRD-181): 발표·실황 기준 시각 뒤 이 시간이 지나면 받지 못한 것으로 봄(2026-11-05 사용자 결정)
  // 단기예보는 3시간마다 발표 → 4번 놓치면, 중기예보는 12시간마다 → 2번, 초단기실황은 매시 → 2번 놓치면 결측
  weatherMaxAgeMs: {
    short: 12 * 60 * MINUTE_MS,
    mid: 24 * 60 * MINUTE_MS,
    now: 2 * 60 * MINUTE_MS,
  },
} as const;

export const MANIFEST_SETTINGS = {
  schemaVersion: 1,
  // 점검 중이면 active: true, until: 종료 예정(UTC ISO, 모르면 null)
  maintenance: { active: false, until: null },
  // 이보다 낮은 화면 버전은 강제 업데이트(BRD-43)
  minWebBuild: 1,
} as const;
