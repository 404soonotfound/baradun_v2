"use client";

import { BeachIllustration } from "@/components/beach-illustration";
import { useShownPhoto } from "@/components/map/beach-photo";
import type { BeachSummary } from "@/lib/beach-summary";
import { cn } from "@/lib/cn";

// 검색 목록·제안·문의의 해변 썸네일 (GH-531 · GH-532 · 결정 기록 29장 D29-5·D29-7·D29-8·D29-9)
// 관광공사 사진(다크 밝기 90%, photo-dim) 또는 사진 없는 해변 그림(#527). 받지 못한 사진도 그림
// 바로 옆에 해변 이름이 있어 화면 읽기에는 숨김(이름을 두 번 읽지 않게). '참고 사진'·출처는 부르는 쪽이 둠

type ThumbClass = { className: string }; // 크기·모서리(예: 72×56 "h-14 w-[72px] rounded-[12px]")

// 사진 상태를 직접 들고 있는 썸네일(검색 목록·제안)
export function BeachThumb({
  photo,
  className,
}: { photo: BeachSummary["photo"] } & ThumbClass) {
  return <BeachThumbView state={useShownPhoto(photo)} className={className} />;
}

// 보여 주기만: 부르는 쪽이 같은 사진의 출처 줄을 둘 때 useShownPhoto 결과를 함께 씀(받지 못하면 출처 줄도 같이 숨게)
export function BeachThumbView({
  state,
  className,
}: { state: ReturnType<typeof useShownPhoto> } & ThumbClass) {
  const { shown, onError, checkBroken } = state;
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
