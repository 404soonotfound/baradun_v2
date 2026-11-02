import { useTranslations } from "next-intl";
import type { ReactNode } from "react";

// 개발용 예시 데이터 안내 (AGENTS.md 제품 규칙: 샘플 데이터와 실제 데이터 구분, BRD-108)
// 홈·탐색·검색·즐겨찾기·장소 상세가 같은 모양·문구를 씀. 판단 카드·카드 목록보다 먼저 둠
// 기본 문구는 예시 특보·관측값 안내(home.sampleSnapshot). 다른 예시 안내(예: 예시 해변 목록)만 children으로 넘김
// 보일지는 부르는 쪽이 정함(sampleSnapshot·sample). 배포 빌드는 늘 false라 나오지 않음
export function SampleNote({ children }: { children?: ReactNode }) {
  const t = useTranslations("home");
  return (
    <p
      role="note"
      className="rounded-card bg-bg-surface px-4 py-3 text-body-s text-text-body shadow-card"
    >
      {children ?? t("sampleSnapshot")}
    </p>
  );
}
