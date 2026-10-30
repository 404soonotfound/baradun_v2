import { useTranslations } from "next-intl";

import { cn } from "@/lib/cn";
import {
  deviceLocationGuide,
  locationRetrying,
  retryLocation,
  type LocationState,
} from "@/lib/location";

// 위치 거부 상태의 '다시 시도' (BRD-139 · 10/30 사용자 결정 A안)
// 설정 '브라우저 위치 권한' 안내 · 홈 위치 배너 · 탐색 '가까운 순' 거부 안내가 같은 부품·문구 키를 씀
// 사용자가 누를 때만 브라우저에 한 번 더 요청(lib/location.ts retry). 꺼짐(off)·거부가 아닌 상태에서는 그리지 않음

// 거부일 때만 버튼. 답을 기다리는 동안은 aria-disabled로 막고 글자를 '위치 확인 중…'으로 바꿈
// disabled 대신 aria-disabled: 누른 버튼의 포커스가 사라지지 않게(키보드·화면 읽기가 결과 문구를 이어서 들음)
export function LocationRetryButton({
  state,
  className,
}: {
  state: LocationState;
  className?: string | undefined;
}) {
  const t = useTranslations("location");
  if (state.status !== "denied") return null;
  const pending = locationRetrying(state);
  return (
    <button
      type="button"
      aria-disabled={pending ? "true" : undefined}
      onClick={pending ? undefined : retryLocation}
      className={cn(
        "font-bold text-brand-default aria-disabled:cursor-default aria-disabled:font-normal aria-disabled:text-text-muted",
        className,
      )}
    >
      {pending ? t("retrying") : t("retry")}
    </button>
  );
}

// 다시 시도했는데도 거부면 기기별 설정 경로(무슨 일 → 영향 → 다음 행동). 그 밖에는 null(화면의 원래 문구)
// 아이폰·아이패드 Safari는 기기 설정 경로, 그 밖·판별 못 함은 브라우저 사이트 설정(lib/location.ts locationGuide)
export function useLocationRetryMessage(state: LocationState): string | null {
  const t = useTranslations("location.retryDenied");
  if (state.status !== "denied" || state.retry !== "denied") return null;
  // 다시 시도를 누른 뒤에만 오는 상태라 서버 HTML·첫 그리기에서는 navigator를 읽지 않음
  return t(deviceLocationGuide());
}
