"use client";

import { useTranslations } from "next-intl";
import { useId } from "react";

import { cn } from "@/lib/cn";

// 사진 없는 해변 그림 (GH-527 · 결정 기록 29장 D29-4, 12장 결정 15 고침)
// 사진이 없거나 받지 못한 해변 자리에 씀. 프로젝트가 직접 그린 자산(원본 assets/illustration/beach-no-photo.svg)
// 하늘 · 해 · 구름 · 바다 · 잔물결 · 모래만 그림(날씨·파도 세기로 읽히지 않게). 정지 그림이라 동작 줄이기와 무관
// 색은 토큰 color.illust.*만 씀(라이트·다크는 토큰이 바꿈)
//
// 쓰는 법: 크기·모서리는 className으로 줌. 그림은 칸을 채우고 넘치는 쪽을 가운데 기준으로 자름(slice)
//   넓은 카드   <BeachIllustration className="h-[132px] w-full rounded-[12px]" /> + '사진 없음 · 그림' 표시(PhotoFigure가 붙임)
//   작은 썸네일 <BeachIllustration className="size-12 shrink-0 rounded-[10px]" /> (48~56px, 표시 문구 없이 그림만)
// 접근 가능한 이름은 '사진 없는 해변 그림'
export function BeachIllustration({
  className,
}: {
  className?: string | undefined;
}) {
  const t = useTranslations("photo");
  // 한 화면에 여러 장이 있어도 그라데이션 id가 겹치지 않게 함(url(#…)에 쓸 수 있는 글자만 남김)
  const id = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const sky = `illust-sky-${id}`;
  const sea = `illust-sea-${id}`;
  return (
    <svg
      viewBox="0 0 320 132"
      preserveAspectRatio="xMidYMid slice"
      className={cn("block", className)}
      role="img"
      aria-label={t("illustration")}
    >
      <defs>
        <linearGradient id={sky} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" className="[stop-color:var(--color-illust-sky-1)]" />
          <stop offset="1" className="[stop-color:var(--color-illust-sky-2)]" />
        </linearGradient>
        <linearGradient id={sea} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" className="[stop-color:var(--color-illust-sea-2)]" />
          <stop offset="1" className="[stop-color:var(--color-illust-sea-1)]" />
        </linearGradient>
      </defs>
      <rect width="320" height="132" fill={`url(#${sky})`} />
      <circle cx="246" cy="34" r="15" className="fill-illust-sun" />
      <g className="fill-illust-cloud">
        <rect x="118" y="22" width="54" height="12" rx="6" />
        <rect x="132" y="15" width="28" height="12" rx="6" />
        <rect x="196" y="42" width="38" height="9" rx="4.5" />
      </g>
      <rect y="61" width="320" height="40" fill={`url(#${sea})`} />
      <g
        fill="none"
        strokeLinecap="round"
        opacity=".55"
        className="stroke-illust-foam"
      >
        <path d="M30 74 q14 -4 28 0 t28 0" strokeWidth="1.6" />
        <path d="M150 70 q12 -3 24 0 t24 0" strokeWidth="1.4" />
        <path d="M226 82 q14 -4 28 0 t28 0" strokeWidth="1.6" />
        <path d="M90 86 q14 -4 28 0 t28 0" strokeWidth="1.6" />
      </g>
      <path
        d="M0 98 C60 90 110 104 170 97 S280 90 320 96 V132 H0Z"
        className="fill-illust-sand-1"
      />
      <path
        d="M0 98 C60 90 110 104 170 97 S280 90 320 96"
        fill="none"
        strokeWidth="2.4"
        opacity=".9"
        className="stroke-illust-foam"
      />
      <path
        d="M0 118 C70 112 140 124 220 116 S300 112 320 116 V132 H0Z"
        className="fill-illust-sand-2"
      />
    </svg>
  );
}
