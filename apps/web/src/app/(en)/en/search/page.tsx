import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { SearchScreen } from "@/components/search/search-screen";
import { listBeachSummaries } from "@/lib/beaches";
import { alternatesFor } from "@/lib/i18n";

// 검색 /search/ (BRD-31). 해변 이름·별칭은 빌드 때 만들어 넘기고, 검색은 브라우저에서 처리(검색어는 ?q=)
const PATH = "/search/";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations({ locale: "en", namespace: "pages" });
  return { title: t("search"), alternates: alternatesFor("en", PATH) };
}

export default function Page() {
  return <SearchScreen locale="en" beaches={listBeachSummaries("en")} />;
}
