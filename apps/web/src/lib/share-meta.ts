// 공유 미리보기(OG·트위터 카드) 정보 (BRD-34 · 결정 기록 11장 10/16·10/27 ⑬, 아키텍처 9장)
// 해변 이름·지역만 넣음. 특보·분류·측정값 같은 상태는 절대 넣지 않음
// (정적 빌드라 미리보기가 지난 상태를 최신처럼 보여줄 수 있음)
// 이미지는 모든 페이지가 자체 공통 일러스트(public/og/share.png)만 씀(BRD-105 · 2026-10-28 확정 결정 16).
// 해변 사진은 출처 표기 의무가 있는데 미리보기 카드에는 출처를 붙일 수 없어 쓰지 않음(상세 화면 사진·출처 표기는 그대로)
import type { Beach } from "@baradun/contracts";
import type { Metadata } from "next";

import { type Locale, localizedPath } from "@/lib/i18n";

// 원본 assets/og/share.svg → npm run og:image
export const SHARE_ILLUSTRATION = {
  url: "/og/share.png",
  width: 1200,
  height: 630,
} as const;

const OG_LOCALE: Record<Locale, string> = { ko: "ko_KR", en: "en_US" };

type ShareText = { siteName: string; illustrationAlt: string };

// 언어별 루트 레이아웃용 기본값. 상세처럼 openGraph·twitter를 직접 두는 페이지는 통째로 덮어씀(Next 얕은 병합)
export function siteShareMetadata(
  locale: Locale,
  text: ShareText,
): Pick<Metadata, "openGraph" | "twitter"> {
  const image = { ...SHARE_ILLUSTRATION, alt: text.illustrationAlt };
  return {
    openGraph: {
      type: "website",
      siteName: text.siteName,
      locale: OG_LOCALE[locale],
      images: [image],
    },
    twitter: { card: "summary_large_image", images: [image] },
  };
}

export function beachShareMetadata(
  beach: Pick<Beach, "slug" | "name" | "region">,
  locale: Locale,
  text: ShareText,
): Pick<Metadata, "openGraph" | "twitter"> {
  const name = beach.name[locale];
  const region = `${beach.region.sido[locale]} ${beach.region.sigungu[locale]}`;
  const image = { ...SHARE_ILLUSTRATION, alt: text.illustrationAlt };
  const title = `${name} · ${text.siteName}`;
  return {
    openGraph: {
      type: "website",
      siteName: text.siteName,
      locale: OG_LOCALE[locale],
      url: localizedPath(locale, `/spots/${beach.slug}/`),
      title,
      description: region,
      images: [image],
    },
    twitter: {
      card: "summary_large_image",
      title,
      description: region,
      images: [image],
    },
  };
}
