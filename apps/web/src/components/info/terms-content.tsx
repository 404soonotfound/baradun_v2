import Link from "next/link";
import { getTranslations } from "next-intl/server";

import { InfoSection } from "@/components/info/info-blocks";
import { localizedPath, type Locale } from "@/lib/i18n";
import { NOTICE_VERSION } from "@/lib/notice-version";

// 서비스 정보·약관 /terms/ (BRD-36 · 노션 2장 POL)
// 서비스 소개 · 면책(안전·활동 적합성을 보장하지 않음, 현장 안내 우선) · 개인정보(위치는 기기 안에서만, 문의 보관 기간) · ON-1 고지 버전
// 문구는 법률 검토(BRD-64) 전 노션 초안. 보관 기간은 결정 기록 9장·11장(10/26 BRD-63)

export async function TermsContent({ locale }: { locale: Locale }) {
  const t = await getTranslations({ locale, namespace: "terms" });
  const tc = await getTranslations({ locale });

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-title-xl text-text-default">{tc("pages.terms")}</h1>

      <InfoSection id="terms-about" title={t("about.title")}>
        <p className="text-body-s text-text-default">{t("about.body1")}</p>
        <p className="text-body-s text-text-body">{t("about.body2")}</p>
      </InfoSection>

      <InfoSection id="terms-disclaimer" title={t("disclaimer.title")}>
        <p className="text-body-s font-bold text-text-default">
          {t("disclaimer.body1")}
        </p>
        <p className="text-body-s text-text-body">{t("disclaimer.body2")}</p>
        <p className="text-body-s font-bold text-text-default">
          {tc("safety.finalCall")}
        </p>
      </InfoSection>

      <InfoSection id="terms-privacy" title={t("privacy.title")}>
        <Item
          title={t("privacy.locationTitle")}
          body={t("privacy.locationBody")}
        />
        <Item title={t("privacy.deviceTitle")} body={t("privacy.deviceBody")} />
        <Item
          title={t("privacy.inquiryTitle")}
          body={t("privacy.inquiryBody")}
          note={t("privacy.inquiryNoDeadline")}
        />
      </InfoSection>

      <nav aria-label={t("links")} className="flex flex-col gap-1">
        <Link
          href={localizedPath(locale, "/about/data/")}
          className="inline-flex min-h-touch items-center text-body-s font-bold text-brand-default"
        >
          {tc("pages.dataSources")}
        </Link>
        <Link
          href={localizedPath(locale, "/guide/")}
          className="inline-flex min-h-touch items-center text-body-s font-bold text-brand-default"
        >
          {tc("pages.guide")}
        </Link>
      </nav>

      <p className="text-caption text-text-muted">
        {t("notice", { version: NOTICE_VERSION })}
      </p>
    </div>
  );
}

function Item({
  title,
  body,
  note,
}: {
  title: string;
  body: string;
  note?: string;
}) {
  return (
    <div className="flex flex-col gap-1">
      <h3 className="text-title-s text-text-default">{title}</h3>
      <p className="text-body-s text-text-body">{body}</p>
      {note && <p className="text-body-s text-text-body">{note}</p>}
    </div>
  );
}
