"use client";

import { useLocale, useTranslations } from "next-intl";

import type { Locale } from "@/lib/i18n";
import { zoneNameText } from "@/lib/zone-name";

// 특보 구역 이름 한 칸 (아키텍처 9.1 · BRD-48)
// 번역표에 있으면 기상청 영어 이름, 없으면 원문(한국어)을 lang="ko"로 두고 'Original text from KMA (Korean)'을 붙임
// block: 칸이 넓은 곳(특보 상세 시트)은 안내를 다음 줄로, 목록 행은 같은 줄 괄호로(문구 키 zoneOriginalInline)
export function ZoneName({
  zone,
  block = false,
}: {
  zone: { zoneCode: string | null; zoneName: string };
  block?: boolean;
}) {
  const t = useTranslations("warning");
  const locale = useLocale() as Locale;
  const { text, untranslated } = zoneNameText(zone, locale);
  if (!untranslated) return <>{text}</>;
  if (block) {
    return (
      <>
        <span lang="ko">{text}</span>
        <span className="block text-caption font-normal text-text-muted">
          {t("zoneOriginal")}
        </span>
      </>
    );
  }
  return t.rich("zoneOriginalInline", {
    zone: () => <span lang="ko">{text}</span>,
    note: (chunks) => (
      <span className="text-caption font-normal text-text-muted">{chunks}</span>
    ),
  });
}
