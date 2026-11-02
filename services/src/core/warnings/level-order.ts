import type { WarningLevel } from "@baradun/contracts";
import { toMs } from "./time";

// 특보 단계 정렬 (아키텍처 6.3 10/21). getPwnCd 해변 특보·지진해일·주변 특보가 같은 규칙을 씀
// 단계 높은 순 → 같은 단계는 발표 이른 순

// 작을수록 높은 단계
const LEVEL_RANK: Record<WarningLevel, number> = {
  severe_warning: 0,
  warning: 1,
  advisory: 2,
};

// 단계 없음(해제)은 맨 뒤. 가장 낮은 단계 다음 순위
const RELEASED_RANK = Math.max(...Object.values(LEVEL_RANK)) + 1;

export function levelRank(level: WarningLevel | null): number {
  return level === null ? RELEASED_RANK : LEVEL_RANK[level];
}

type Ranked = { level: WarningLevel; publishedAt: string };
export function byLevelThenTime(a: Ranked, b: Ranked): number {
  return (
    LEVEL_RANK[a.level] - LEVEL_RANK[b.level] ||
    toMs(a.publishedAt) - toMs(b.publishedAt)
  );
}
