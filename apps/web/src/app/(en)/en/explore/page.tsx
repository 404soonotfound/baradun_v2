import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { ExploreScreen } from "@/components/explore/explore-screen";
import { listBeachSummaries } from "@/lib/beaches";
import { hasDevSampleSnapshot } from "@/lib/dev-sample";
import { alternatesFor } from "@/lib/i18n";

// 탐색 /explore/ (BRD-29). 해변 목록은 빌드 때 만들어 넘기고, 상태는 브라우저가 따로 받음(G4)
const PATH = "/explore/";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations({ locale: "en", namespace: "pages" });
  return { title: t("explore"), alternates: alternatesFor("en", PATH) };
}

export default function Page() {
  return (
    <ExploreScreen
      locale="en"
      beaches={listBeachSummaries("en")}
      sampleSnapshot={hasDevSampleSnapshot()}
    />
  );
}
