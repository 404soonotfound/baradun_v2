"use client";

import { useTranslations } from "next-intl";
import { useState } from "react";

import type { Beach } from "@baradun/contracts";
import { PhotoCredit, useShownPhoto } from "@/components/map/beach-photo";
import { cn } from "@/lib/cn";

// 상세 사진 커버 (GH-528 · 결정 기록 29장 D29-1·D29-8, 2장 DET '2026-11-16 사진 커버', 시안 D_PLDV3·D_WXMV3)
// 판단 묶음 카드 맨 위에 붙는 한국관광공사 참고 사진. 모바일 카드 폭 × 164, PC 384 × 188. 모서리는 묶음 카드가 자름
// 사진 왼쪽 아래: '참고 사진 · 지금 바다 모습 아님' 표시 + 출처(링크·작품명은 PhotoCredit 규칙 그대로). 상세 링크 안이 아니라 출처 링크를 그대로 둠
// 사진이 없거나 받지 못하면 아무것도 그리지 않음(빈 자리·그림 없음 → D안 그대로). 사진은 판단·상태 계산에 쓰지 않음
// 자리(높이)를 먼저 잡아 사진이 늦게 와도 아래 판단 카드가 밀리지 않음. 받기 실패일 때만 자리를 없앰
// 크기는 D29-1의 두 가지(모바일 164 · PC 188)만 둠
export function PhotoCover({
  photo,
  name,
}: {
  photo: Beach["photo"];
  name: string;
}) {
  const t = useTranslations("photo");
  const { shown, onError, checkBroken } = useShownPhoto(photo);
  // 받은 사진 주소. 받기 전에는 빈 자리 위에 표시·출처를 그리지 않음(없는 사진을 설명하지 않게)
  const [loadedUrl, setLoadedUrl] = useState<string | null>(null);

  if (shown === null) return null;
  const loaded = loadedUrl === shown.url;
  return (
    <figure className="relative h-[164px] overflow-hidden bg-bg-subtle lg:h-[188px]">
      {/* 바깥 사진 주소를 그대로 씀(정적 내보내기라 이미지 최적화 서버가 없음). 첫 화면 맨 위라 미루지 않고 받음 */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        // 정적 HTML의 사진이 화면 코드보다 먼저 끝나면(받음·실패) 이벤트를 놓치므로, 붙을 때 한 번 확인함
        ref={(img) => {
          if (img?.complete && img.naturalWidth > 0) setLoadedUrl(shown.url);
          checkBroken(img);
        }}
        src={shown.url}
        alt={t("alt", { name })}
        fetchPriority="high"
        decoding="async"
        onLoad={() => setLoadedUrl(shown.url)}
        onError={onError}
        // 모든 해변 가운데 위쪽 고정(D29-8). photo-dim: 다크에서 밝기 90%(globals.css)
        className="photo-dim size-full object-cover object-[center_30%]"
      />
      {/* 글자가 읽히게 글자 뒤만 아래로 갈수록 어둡게. 출처가 두 줄이 돼도 그라데이션이 같이 늘어남 */}
      <figcaption
        className={cn(
          "absolute inset-x-0 bottom-0 flex flex-col items-start gap-[5px] bg-linear-to-b from-transparent to-photo-scrim px-3 pt-7 pb-[9px] lg:gap-1.5 lg:pb-2.5",
          !loaded && "invisible",
        )}
      >
        <span className="flex h-6 items-center rounded-full bg-photo-scrim px-[9px] text-caption font-bold text-photo-on">
          {t("reference")}
        </span>
        <PhotoCredit
          photo={shown}
          short
          className="text-photo-on [text-shadow:0_1px_3px_var(--color-photo-shadow)]"
        />
      </figcaption>
    </figure>
  );
}
