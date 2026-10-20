import { getTranslations } from "next-intl/server";

import type { Beach } from "@baradun/contracts";
import type { Locale } from "@/lib/i18n";
import { ActivityButton } from "@/components/detail/activity-button";
import { BackButton } from "@/components/detail/back-butotn";

// 장소 상세 자리 (BRD-24 묶음 3). 실제 화면(판단 카드·바다 상태 등)은 BRD-32에서 구현
// 머리(노션 3장 DetailHeader 62px): 뒤로 · 해변명+지역 · 활동 버튼 (공유는 BRD-34)
export async function DetailPlaceholder({
  locale,
  beach,
  sample,
}: {
  locale: Locale;
  beach: Beach;
  sample: boolean;
}) {
  const t = await getTranslations({ locale });
  const region = `${beach.region.sido[locale]} ${beach.region.sigungu[locale]}`;

  return (
    <>
      <header className="-mx-2 flex h-detail-header items-center gap-1">
        <BackButton locale={locale} />
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-title-m">{beach.name[locale]}</h1>
          <p className="truncate text-caption text-text-muted">{region}</p>
        </div>
        <ActivityButton />
      </header>
      <p className="mt-4 text-text-body">{t("home.preparing")}</p>
      {sample && (
        <p className="mt-2 text-caption text-text-muted">
          {t("detail.sample")}
        </p>
      )}
    </>
  );
}
