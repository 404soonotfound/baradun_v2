import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { GuideContent } from "@/components/guide/guide-content";
import { alternatesFor } from "@/lib/i18n";

// /guide/ (BRD-36). 정적 안내라 빌드 때 그림
const PATH = "/guide/";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations({ locale: "ko", namespace: "pages" });
  return { title: t("guide"), alternates: alternatesFor("ko", PATH) };
}

export default function Page() {
  return <GuideContent locale="ko" />;
}
