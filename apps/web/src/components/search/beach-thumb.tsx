"use client";

import { BeachIllustration } from "@/components/beach-illustration";
import { useShownPhoto } from "@/components/map/beach-photo";
import type { BeachSummary } from "@/lib/beach-summary";
import { cn } from "@/lib/cn";

// 검색 목록·제안의 해변 썸네일 (GH-531 · 결정 기록 29장 D29-5·D29-7·D29-8)
// 관광공사 사진(다크 밝기 90%, photo-dim) 또는 사진 없는 해변 그림(#527). 받지 못한 사진도 그림
// 바로 옆에 해변 이름이 있어 화면 읽기에는 숨김(이름을 두 번 읽지 않게). '참고 사진'·출처는 화면 아래 안내 줄에 둠
export function BeachThumb({
  photo,
  className,
  state,
}: {
  photo: BeachSummary["photo"];
  className: string; // 크기·모서리(예: 72×56 "h-14 w-[72px] rounded-[12px]")
  // 부르는 쪽이 같은 사진의 출처 줄을 둘 때 넘기는 useShownPhoto 결과(받지 못한 사진이면 출처 줄도 같이 숨게)
  state?: ReturnType<typeof useShownPhoto>;
}) {
  const own = useShownPhoto(state ? null : photo);
  const { shown, onError, checkBroken } = state ?? own;
  if (shown === null) {
    return (
      <BeachIllustration decorative className={cn("shrink-0", className)} />
    );
  }
  return (
    // 바깥 사진 주소를 그대로 씀(정적 내보내기라 이미지 최적화 서버가 없음)
    // eslint-disable-next-line @next/next/no-img-element
    <img
      ref={checkBroken}
      src={shown.url}
      alt=""
      loading="lazy"
      onError={onError}
      className={cn("photo-dim shrink-0 object-cover", className)}
    />
  );
}
