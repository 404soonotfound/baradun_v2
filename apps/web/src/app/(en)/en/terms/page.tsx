import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { TermsContent } from "@/components/info/terms-content";
import { alternatesFor } from "@/lib/i18n";
import { SettingsLayout } from "@/components/settings/settings-nav";

// /terms/ (BRD-36). 정적 안내라 빌드 때 그림
const PATH = "/terms/";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations({ locale: "en", namespace: "pages" });
  return { title: t("terms"), alternates: alternatesFor("en", PATH) };
}

export default function Page() {
  // PC는 설정과 같은 좌우 배치(왼쪽 설정 목록)
  return (
    <SettingsLayout locale="en">
      <TermsContent locale="en" />
    </SettingsLayout>
  );
}
