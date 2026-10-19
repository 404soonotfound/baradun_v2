import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { PlaceholderPage } from "@/components/placeholder-page";
import { alternatesFor } from "@/lib/i18n";

// /guide/ (아키텍처 9장 확정 경로). 실제 화면은 화면 이슈에서 채워요 (BRD-24)
const PATH = "/guide/";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations({ locale: "en", namespace: "pages" });
  return { title: t("guide"), alternates: alternatesFor("en", PATH) };
}

export default function Page() {
  return <PlaceholderPage locale="en" page="guide" />;
}
