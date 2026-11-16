"use client";

import { Waves } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useState, type ReactNode } from "react";

import { BeachIllustration } from "@/components/beach-illustration";
import type { BeachSummary } from "@/lib/beach-summary";
import { cn } from "@/lib/cn";
import { META_SEPARATOR } from "@/lib/meta-join";
import { photoSourceUrl } from "@/lib/photo-credit";
import { useMetaText } from "@/lib/snapshot/use-meta-text";

// 해변 참고 사진 (BRD-30 · 노션 3장 BeachPhoto, 결정 기록 11장 10/21 공공누리 1유형만)
// 사진 아래에 "참고 사진 · 지금 바다 모습 아님" + 출처(링크)·공공누리 유형. 사진을 자르거나 거르지 않음(object-cover만)
// 사진이 없거나 받지 못하면 자체 해변 그림 + 왼쪽 위 '사진 없음 · 그림' 표시(GH-527 · 결정 기록 29장 D29-4)
// 그림이 실제 바다 상태로 읽히지 않게 넓은 카드에서는 표시를 빼지 않음. 작은 썸네일은 BeachIllustration만 씀
// 공유 시트 미리보기(BeachPhoto)는 바꾸지 않아 파도 아이콘 + 안내 그대로(SHARE 명세, empty="icon")
// 출처는 링크라 다른 링크 안에 넣지 않음. 사진을 링크 안에 두는 곳(지도 카드)은 PhotoFigure(credit 없음) +
// 링크 밖 PhotoCredit으로 나눠 씀(받지 못한 사진 상태는 useShownPhoto 하나로 같이 봄)

type Photo = NonNullable<BeachSummary["photo"]>;

// 보여줄 사진 고르기. 사진이 없거나 받지 못한 주소면 null(→ 그림). 다른 주소면 다시 보여줌
export function pickShownPhoto(
  photo: BeachSummary["photo"],
  brokenUrl: string | null,
): Photo | null {
  return photo !== null && photo.url !== brokenUrl ? photo : null;
}

// 보여줄 사진. 받지 못한 사진 주소는 기억해 그림으로 바꾸고, 다른 해변(다른 주소)으로 바뀌면 다시 시도함
export function useShownPhoto(photo: BeachSummary["photo"]) {
  const [brokenUrl, setBrokenUrl] = useState<string | null>(null);
  // 망이 끊겨 받지 못한 사진은 다시 연결되면 한 번 더 시도함(새로 고치지 않아도 사진이 돌아오게)
  useEffect(() => {
    const retry = () => setBrokenUrl(null);
    window.addEventListener("online", retry);
    return () => window.removeEventListener("online", retry);
  }, []);
  const shown = pickShownPhoto(photo, brokenUrl);
  const onError = () => {
    if (shown) setBrokenUrl(shown.url);
  };
  // img의 ref로 붙임. 오류 이벤트를 놓친 사진(정적 HTML의 사진이 화면 코드보다 먼저 실패, 같은 주소가 이미 실패해
  // 브라우저가 이벤트 없이 깨진 그림으로 둔 경우)을 붙을 때 한 번 확인함
  const checkBroken = (img: HTMLImageElement | null) => {
    if (img?.complete && img.naturalWidth === 0) onError();
  };
  return { shown, onError, checkBroken };
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
  const { shown, onError, checkBroken } = useShownPhoto(photo);
  return (
    <PhotoFigure
      shown={shown}
      name={name}
      className={className}
      onError={onError}
      checkBroken={checkBroken}
      credit
      empty="icon"
    />
  );
}

// 사진(또는 그림) + 캡션. credit이 false면 캡션은 '참고 사진 · 지금 바다 모습 아님'만(출처는 부르는 쪽이 PhotoCredit으로)
// empty: 사진 없음(없음·받기 실패 모두) 자리. 기본은 해변 그림, "icon"은 공유 시트 미리보기의 파도 아이콘
export function PhotoFigure({
  shown,
  name,
  className,
  onError,
  checkBroken,
  credit,
  empty = "illustration",
}: {
  shown: Photo | null;
  name: string;
  className?: string | undefined;
  onError: () => void;
  checkBroken?: (img: HTMLImageElement | null) => void; // useShownPhoto의 checkBroken
  credit: boolean;
  empty?: "illustration" | "icon";
}) {
  const t = useTranslations("photo");

  if (shown === null && empty === "illustration") {
    return (
      <figure className="relative">
        <BeachIllustration className={cn("w-full rounded-[12px]", className)} />
        {/* 사진의 '참고 사진' 표시와 같은 자리·모양(시안 S_EXPPCN)
            보이는 글자라 링크 안에서도 접근 가능한 이름에 그대로 둠(WCAG 2.5.3, 사진의 alt + 안내와 같은 구조) */}
        <figcaption className="absolute top-2 left-2 flex h-6 items-center rounded-full bg-illust-label-bg px-[9px] text-caption font-bold text-illust-label-fg">
          {t("noneLabel")}
        </figcaption>
      </figure>
    );
  }

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
        ref={checkBroken}
        src={shown.url}
        alt={t("alt", { name })}
        loading="lazy"
        onError={onError}
        // photo-dim: 다크에서 밝기 90%(D29-8, globals.css)
        className={cn(
          "photo-dim w-full rounded-[12px] object-cover",
          className,
        )}
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
// short: 상세 커버처럼 사진 위 좁은 자리에 얹는 짧은 표기('사진 한국관광공사 · 공공누리 제1유형', D29-1). 링크·작품명 규칙은 같음
export function PhotoCredit({
  photo,
  className,
  short = false,
}: {
  photo: Photo;
  className?: string;
  short?: boolean;
}) {
  return (
    <p className={cn("text-caption text-text-muted", className)}>
      <CreditText photo={photo} short={short} />
    </p>
  );
}

// "사진 출처: 한국관광공사(링크), 「제목」 · 공공누리 제1유형"
function CreditText({
  photo,
  short = false,
}: {
  photo: Photo;
  short?: boolean;
}) {
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
    ? t.rich(short ? "coverCreditWithTitle" : "creditWithTitle", {
        source,
        title: photo.title,
        license,
        link,
      })
    : t.rich(short ? "coverCredit" : "credit", { source, license, link });
}
