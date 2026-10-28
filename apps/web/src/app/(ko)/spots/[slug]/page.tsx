import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";

import { DetailScreen } from "@/components/detail/detail-screen";
import {
  beachSlugParams,
  findBeach,
  listAltCandidates,
  listVisibleBeachIds,
} from "@/lib/beaches";
import { alternatesFor } from "@/lib/i18n";
import { beachShareMetadata } from "@/lib/share-meta";

// /spots/[slug]/ 장소 상세 (아키텍처 9장). 경로는 data/beaches에서 생성(B6, BRD-45)
// 정적 내보내기라 빌드 때 만든 slug만 존재. 없는 slug·숨긴 해변은 404
export const dynamicParams = false;

export function generateStaticParams() {
  return beachSlugParams();
}

type Props = { params: Promise<{ slug: string }> };

// 탭 제목 "경포해수욕장 · 바라던 바다" + 영어 주소 연결(영어 페이지와 같은 방식)
export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  const found = findBeach(slug);
  if (!found) return {};
  const t = await getTranslations({ locale: "ko" });
  const name = found.beach.name.ko;
  return {
    title: name,
    alternates: alternatesFor("ko", `/spots/${slug}/`),
    // 공유 미리보기: 이름·지역·사진만, 상태 없음 (BRD-34)
    ...beachShareMetadata(found.beach, "ko", {
      siteName: t("meta.siteName"),
      photoAlt: t("photo.alt", { name }),
      illustrationAlt: t("share.ogIllustration"),
    }),
  };
}

export default async function Page({ params }: Props) {
  const { slug } = await params;
  const found = findBeach(slug);
  if (!found) notFound(); // 해변이 없을 때의 자리 slug("_")도 여기서 404
  return (
    <DetailScreen
      locale="ko"
      beach={found.beach}
      beaches={listAltCandidates(found.beach, "ko")}
      allBeachIds={listVisibleBeachIds()}
      sample={found.sample}
    />
  );
}
