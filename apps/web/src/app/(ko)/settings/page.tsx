import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { PlaceholderPage } from "@/components/placeholder-page";
import { alternatesFor } from "@/lib/i18n";

// /settings/ (아키텍처 9장 확정 경로). 실제 화면은 화면 이슈에서 채워요 (BRD-24)
const PATH = "/settings/";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations({ locale: "ko", namespace: "pages" });
  return { title: t("settings"), alternates: alternatesFor("ko", PATH) };
}

export default function Page() {
  return <PlaceholderPage locale="ko" page="settings" />;
}
