import type { Metadata } from "next";
import { Suspense } from "react";
import { getTranslations } from "next-intl/server";
import {
  SearchFallback,
  SearchScreen,
} from "@/components/search/search-screen";
import { listBeachSummaries } from "@/lib/beaches";
import { hasDevSampleSnapshot } from "@/lib/dev-sample";
import { alternatesFor } from "@/lib/i18n";

// 검색 /search/ (BRD-31). 해변 이름·별칭은 빌드 때 만들어 넘기고, 검색은 브라우저에서 처리(검색어는 ?q=)
const PATH = "/search/";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations({ locale: "en", namespace: "pages" });
  return { title: t("search"), alternates: alternatesFor("en", PATH) };
}

export default function Page() {
  // useSearchParams는 정적 HTML을 만들 때 주소를 몰라 Suspense로 감쌈(브라우저에서 이어 그림)
  return (
    <Suspense fallback={<SearchFallback />}>
      <SearchScreen
        locale="en"
        beaches={listBeachSummaries("en")}
        sampleSnapshot={hasDevSampleSnapshot()}
      />
    </Suspense>
  );
}
