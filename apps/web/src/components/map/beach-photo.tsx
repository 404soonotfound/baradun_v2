"use client";

import { Waves } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState, type ReactNode } from "react";

import type { BeachSummary } from "@/lib/beach-summary";
import { cn } from "@/lib/cn";
import { META_SEPARATOR } from "@/lib/meta-join";
import { photoSourceUrl } from "@/lib/photo-credit";
import { useMetaText } from "@/lib/snapshot/use-meta-text";

// 해변 참고 사진 (BRD-30 · 노션 3장 BeachPhoto, 결정 기록 11장 10/21 공공누리 1유형만)
// 사진 아래에 "참고 사진 · 지금 바다 모습 아님" + 출처(링크)·공공누리 유형. 사진을 자르거나 거르지 않음(object-cover만)
// 사진이 없거나 받지 못하면 일러스트 자리(lucide Waves 파도 아이콘 = V1 정식 자산, 2026-10-28 확정 결정 15) + 안내
// 출처는 링크라 다른 링크 안에 넣지 않음. 사진을 링크 안에 두는 곳(지도 카드)은 PhotoFigure(credit 없음) +
// 링크 밖 PhotoCredit으로 나눠 씀(받지 못한 사진 상태는 useShownPhoto 하나로 같이 봄)

type Photo = NonNullable<BeachSummary["photo"]>;

// 보여줄 사진. 받지 못한 사진 주소는 기억해 일러스트로 바꾸고, 다른 해변(다른 주소)으로 바뀌면 다시 시도함
export function useShownPhoto(photo: BeachSummary["photo"]) {
  const [brokenUrl, setBrokenUrl] = useState<string | null>(null);
  const shown = photo !== null && photo.url !== brokenUrl ? photo : null;
  const onError = () => {
    if (shown) setBrokenUrl(shown.url);
  };
  return { shown, onError };
}

export function BeachPhoto({
  photo,
  name,
  className,
}: {
  photo: BeachSummary["photo"];
  name: string;
  className?: string; // 사진 높이(모바일 104px, PC 150px)
}) {
  const { shown, onError } = useShownPhoto(photo);
  return (
    <PhotoFigure
      shown={shown}
      name={name}
      className={className}
      onError={onError}
      credit
    />
  );
}

// 사진(또는 일러스트) + 캡션. credit이 false면 캡션은 '참고 사진 · 지금 바다 모습 아님'만(출처는 부르는 쪽이 PhotoCredit으로)
export function PhotoFigure({
  shown,
  name,
  className,
  onError,
  credit,
}: {
  shown: Photo | null;
  name: string;
  className?: string | undefined;
  onError: () => void;
  credit: boolean;
}) {
  const t = useTranslations("photo");

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

  return (
    <figure className="flex flex-col gap-1">
      {/* 바깥 사진 주소를 그대로 씀(정적 내보내기라 이미지 최적화 서버가 없음) */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={shown.url}
        alt={t("alt", { name })}
        loading="lazy"
        onError={onError}
        className={cn("w-full rounded-[12px] object-cover", className)}
      />
      <figcaption className="text-caption text-text-muted">
        {t("reference")}
        {credit && (
          <>
            {META_SEPARATOR}
            <CreditText photo={shown} />
          </>
        )}
      </figcaption>
    </figure>
  );
}

// 사진 출처 한 줄(링크 밖에 따로 둘 때). 사진을 보여줄 때만 부름
export function PhotoCredit({
  photo,
  className,
}: {
  photo: Photo;
  className?: string;
}) {
  return (
    <p className={cn("text-caption text-text-muted", className)}>
      <CreditText photo={photo} />
    </p>
  );
}

// "사진 출처: 한국관광공사(링크), 「제목」 · 공공누리 제1유형"
function CreditText({ photo }: { photo: Photo }) {
  const t = useTranslations("photo");
  const tc = useTranslations("common");
  const { agencyText } = useMetaText();
  const license = t(`license.${photo.license}`);
  // 출처 기관: 아는 기관만 문구 키로, 모르는 기관은 원문 그대로(lib/agencies 표)
  const source = agencyText(photo.source);
  // 출처 이름에 출처 웹사이트 링크(공공누리 제1유형, BRD-113). 새 창이라고 화면 읽기에 알림. 주소를 모르면 글자만
  const href = photoSourceUrl(photo);
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
  return photo.title
    ? t.rich("creditWithTitle", {
        source,
        title: photo.title,
        license,
        link,
      })
    : t.rich("credit", { source, license, link });
}
