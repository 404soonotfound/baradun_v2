"use client";

import { Waves } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState, type ReactNode } from "react";

import type { BeachSummary } from "@/lib/beach-summary";
import { cn } from "@/lib/cn";
import { photoSourceUrl } from "@/lib/photo-credit";

// 해변 참고 사진 (BRD-30 · 노션 3장 BeachPhoto, 결정 기록 11장 10/21 공공누리 1유형만)
// 사진 아래에 "참고 사진 · 지금 바다 모습 아님" + 출처(링크)·공공누리 유형. 사진을 자르거나 거르지 않음(object-cover만)
// 출처가 링크라 다른 링크 안에 넣지 않음(지도 카드는 사진을 상세 링크 밖에 둠)
// 사진이 없거나 받지 못하면 일러스트 자리(lucide Waves 파도 아이콘 = V1 정식 자산, 2026-10-28 확정 결정 15) + 안내
export function BeachPhoto({
  photo,
  name,
  className,
}: {
  photo: BeachSummary["photo"];
  name: string;
  className?: string; // 사진 높이(모바일 104px, PC 150px)
}) {
  const t = useTranslations("photo");
  const tc = useTranslations("common");
  // 받지 못한 사진 주소. 다른 해변으로 바뀌면 다시 시도함
  const [brokenUrl, setBrokenUrl] = useState<string | null>(null);
  const shown = photo !== null && photo.url !== brokenUrl ? photo : null;

  if (shown === null) {
    return (
      <figure className="flex flex-col gap-1">
        <div
          aria-hidden="true"
          className={cn(
            "flex items-center justify-center rounded-[12px] bg-brand-weak text-brand-default",
            className,
          )}
        >
          <Waves size={32} />
        </div>
        <figcaption className="text-caption text-text-muted">
          {t("none")}
        </figcaption>
      </figure>
    );
  }

  const license = t(`license.${shown.license}`);
  // 출처 기관: 데이터 값(한국어 원문) 중 아는 기관만 문구 키로. 모르는 기관은 원문 그대로(use-meta-text agencyText와 같은 방식)
  const source =
    shown.source === "한국관광공사" ? t("sourceName.kto") : shown.source;
  // 출처 이름에 출처 웹사이트 링크(공공누리 제1유형, BRD-113). 새 창이라고 화면 읽기에 알림. 주소를 모르면 글자만
  const href = photoSourceUrl(shown);
  const link = (chunks: ReactNode) =>
    href ? (
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className="underline underline-offset-2"
      >
        {chunks}
        <span className="sr-only"> ({tc("newWindow")})</span>
      </a>
    ) : (
      chunks
    );
  return (
    <figure className="flex flex-col gap-1">
      {/* 바깥 사진 주소를 그대로 씀(정적 내보내기라 이미지 최적화 서버가 없음) */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={shown.url}
        alt={t("alt", { name })}
        loading="lazy"
        onError={() => setBrokenUrl(shown.url)}
        className={cn("w-full rounded-[12px] object-cover", className)}
      />
      <figcaption className="text-caption text-text-muted">
        {t("reference")} ·{" "}
        {shown.title
          ? t.rich("creditWithTitle", {
              source,
              title: shown.title,
              license,
              link,
            })
          : t.rich("credit", { source, license, link })}
      </figcaption>
    </figure>
  );
}
