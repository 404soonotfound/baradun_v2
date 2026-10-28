import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { DataSourcesContent } from "@/components/info/data-sources-content";
import { alternatesFor } from "@/lib/i18n";

// /about/data/ (BRD-36). 정적 안내라 빌드 때 그림
const PATH = "/about/data/";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations({ locale: "ko", namespace: "pages" });
  return { title: t("dataSources"), alternates: alternatesFor("ko", PATH) };
}

export default function Page() {
  return <DataSourcesContent locale="ko" />;
}
