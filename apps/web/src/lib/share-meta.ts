// 공유 미리보기(OG·트위터 카드) 정보 (BRD-34 · 결정 기록 11장 10/16·10/27 ⑬, 아키텍처 9장)
// 해변 이름·지역·사진만 넣음. 특보·분류·측정값 같은 상태는 절대 넣지 않음
// (정적 빌드라 미리보기가 지난 상태를 최신처럼 보여줄 수 있음)
// 사진은 공공누리 1유형 https 사진만, 아니면 공통 일러스트(public/og/share.png)
import type { Beach } from "@baradun/contracts";
import type { Metadata } from "next";

import { type Locale, localizedPath } from "@/lib/i18n";

export const SHARE_ILLUSTRATION = {
  url: "/og/share.png",
  width: 1200,
  height: 630,
} as const;

const OG_LOCALE: Record<Locale, string> = { ko: "ko_KR", en: "en_US" };

// 미리보기에 쓸 사진. 1유형이 아니거나 https 주소가 아니면 null(→ 일러스트)
export function sharePhotoUrl(photo: Beach["photo"]): string | null {
  if (!photo || photo.license !== "kogl-type1") return null;
  try {
    return new URL(photo.url).protocol === "https:" ? photo.url : null;
  } catch {
    return null;
  }
}

export function beachShareMetadata(
  beach: Pick<Beach, "slug" | "name" | "region" | "photo">,
  locale: Locale,
  text: { siteName: string; photoAlt: string; illustrationAlt: string },
): Pick<Metadata, "openGraph" | "twitter"> {
  const name = beach.name[locale];
  const region = `${beach.region.sido[locale]} ${beach.region.sigungu[locale]}`;
  const photoUrl = sharePhotoUrl(beach.photo);
  const image = photoUrl
    ? { url: photoUrl, alt: text.photoAlt }
    : { ...SHARE_ILLUSTRATION, alt: text.illustrationAlt };
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
