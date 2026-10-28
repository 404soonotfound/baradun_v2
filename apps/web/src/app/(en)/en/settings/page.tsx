import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { SettingsScreen } from "@/components/settings/settings-screen";
import { listBeachSummaries } from "@/lib/beaches";
import { alternatesFor } from "@/lib/i18n";

// 설정 /settings/ (BRD-36). 해변 목록(기본 지역 고르기용)은 빌드 때 넘기고, 기기 저장값은 브라우저에서 읽음
const PATH = "/settings/";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations({ locale: "en", namespace: "pages" });
  return { title: t("settings"), alternates: alternatesFor("en", PATH) };
}

export default function Page() {
  return <SettingsScreen locale="en" beaches={listBeachSummaries("en")} />;
}
