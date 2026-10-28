import type { Metadata } from "next";
import { Suspense } from "react";
import { getTranslations } from "next-intl/server";
import {
  FavoritesFallback,
  FavoritesScreen,
} from "@/components/favorites/favorites-screen";
import { listBeachSummaries } from "@/lib/beaches";
import { hasDevSampleSnapshot } from "@/lib/dev-sample";
import { alternatesFor } from "@/lib/i18n";

// 즐겨찾기 /favorites/ (BRD-35). 해변 목록은 빌드 때 넘기고, 즐겨찾기·최근 본(기기 저장)과 상태는 브라우저에서 읽음
const PATH = "/favorites/";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations({ locale: "ko", namespace: "pages" });
  return { title: t("favorites"), alternates: alternatesFor("ko", PATH) };
}

export default function Page() {
  // useSearchParams(?tab=recent)는 정적 HTML을 만들 때 주소를 몰라 Suspense로 감쌈(브라우저에서 이어 그림)
  return (
    <Suspense fallback={<FavoritesFallback />}>
      <FavoritesScreen
        locale="ko"
        beaches={listBeachSummaries("ko")}
        sampleSnapshot={hasDevSampleSnapshot()}
      />
    </Suspense>
  );
}
