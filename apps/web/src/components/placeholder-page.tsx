import { getTranslations } from "next-intl/server";
import type { Locale } from "@/lib/i18n";
import { CurrentActivity } from "@/components/current-activity";

// 아직 화면이 없는 경로 (BRD-24)
export type PageKey = "inquiry";

export async function PlaceholderPage({
  locale,
  page,
}: {
  locale: Locale;
  page: PageKey;
}) {
  const t = await getTranslations({ locale });

  return (
    <>
      <h1 className="text-title-xl">{t(`pages.${page}`)}</h1>
      <p className="mt-2 text-text-body">{t("home.preparing")}</p>
      <CurrentActivity />
    </>
  );
}
