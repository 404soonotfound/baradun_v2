import Link from "next/link";
import { getTranslations } from "next-intl/server";
import type { ReactNode } from "react";

import { InfoSection } from "@/components/info/info-blocks";
import { localizedPath, type Locale } from "@/lib/i18n";
import { INQUIRY_CONTACT_ENABLED } from "@/lib/inquiry/form";
import { NOTICE_VERSION } from "@/lib/notice-version";

// 서비스 정보·약관 /terms/ (BRD-36·64)
// 이용 안내·면책 → 개인정보 처리방침 → 고지 버전·시행일 순서의 문서형 화면

export async function TermsContent({ locale }: { locale: Locale }) {
  const t = await getTranslations({ locale, namespace: "terms" });
  const tc = await getTranslations({ locale });

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-title-xl text-text-default">{tc("pages.terms")}</h1>

      <InfoSection id="terms-guidance" title={t("guidance.title")}>
        <Item title={t("guidance.doesTitle")}>
          <p>{t("guidance.doesBody1")}</p>
          <p>{t("guidance.doesBody2")}</p>
        </Item>
        <Item title={t("guidance.doesNotTitle")}>
          <p>{t("guidance.doesNotBody1")}</p>
          <p>{t("guidance.doesNotBody2")}</p>
          <p>{t("guidance.doesNotBody3")}</p>
        </Item>
        <Item title={t("guidance.limitsTitle")}>
          <p>{t("guidance.limitsBody1")}</p>
          <p>{t("guidance.limitsBody2")}</p>
        </Item>
        <Item title={t("guidance.finalTitle")}>
          <p className="font-bold text-text-default">
            {t("guidance.finalBody")}
          </p>
        </Item>
        <Item title={t("guidance.responsibilityTitle")}>
          <p>{t("guidance.responsibilityBody1")}</p>
          <p>{t("guidance.responsibilityBody2")}</p>
        </Item>
        <Item title={t("guidance.changesTitle")}>
          <p>{t("guidance.changesBody")}</p>
        </Item>
        <Item title={t("guidance.sourcesTitle")}>
          <p>{t("guidance.sourcesBody")}</p>
          <Link
            href={localizedPath(locale, "/about/data/")}
            className="inline-flex min-h-touch items-center font-bold text-brand-default"
          >
            {tc("pages.dataSources")}
          </Link>
        </Item>
      </InfoSection>

      <InfoSection id="terms-privacy" title={t("privacy.title")}>
        <p className="text-body-s font-bold text-text-default">
          {t("privacy.effectiveDate")}
        </p>
        <p className="text-body-s text-text-body">{t("privacy.intro")}</p>

        <Item title={t("privacy.processingTitle")}>
          <p>{t("privacy.processingInquiry")}</p>
          <p>{t("privacy.processingPurpose")}</p>
          <p>{t("privacy.processingDuplicate")}</p>
          <p>{t("privacy.processingCaution")}</p>
        </Item>
        <Item title={t("privacy.retentionTitle")}>
          <p>{t("privacy.retentionInquiry")}</p>
          <p>{t("privacy.retentionDuplicate")}</p>
          <p>{t("privacy.retentionLogs")}</p>
          <p>{t("privacy.retentionDeletion")}</p>
        </Item>
        <Item title={t("privacy.deviceDetailTitle")}>
          <p>{t("privacy.locationDetail")}</p>
          <p>{t("privacy.deviceDetailBody")}</p>
          <p>{t("privacy.deviceDelete")}</p>
        </Item>
        <Item title={t("privacy.sharingTitle")}>
          <p>{t("privacy.sharingBody")}</p>
        </Item>
        <Item title={t("privacy.storageTitle")}>
          <p>{t("privacy.storageBody")}</p>
        </Item>
        <Item title={t("privacy.externalTitle")}>
          <p>{t("privacy.externalBody")}</p>
        </Item>
        <Item title={t("privacy.cookiesTitle")}>
          <p>{t("privacy.cookiesBody")}</p>
        </Item>
        <Item title={t("privacy.rightsTitle")}>
          <p>{t("privacy.rightsBody")}</p>
          <p>{t("privacy.rightsContact")}</p>
          <p>{t("privacy.rightsHelp")}</p>
        </Item>
        <Item title={t("privacy.securityTitle")}>
          <p>{t("privacy.securityHttps")}</p>
          <p>{t("privacy.securityWrite")}</p>
          <p>{t("privacy.securityDeletion")}</p>
          <p>{t("privacy.securityLogs")}</p>
          <p>{t("privacy.securityStorage")}</p>
        </Item>
        <Item title={t("privacy.officerTitle")}>
          <p>{t("privacy.officerBody")}</p>
        </Item>
        <Item title={t("privacy.changesTitle")}>
          <p>{t("privacy.changesBody")}</p>
        </Item>

        {INQUIRY_CONTACT_ENABLED && (
          <Item title={t("privacy.inquiryTitle")}>
            <p>{t("privacy.inquiryBody")}</p>
            <p>{t("privacy.inquiryNoDeadline")}</p>
          </Item>
        )}
      </InfoSection>

      <p className="text-caption text-text-muted">
        {t("notice", { version: NOTICE_VERSION })}
      </p>
    </div>
  );
}

function Item({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <h3 className="text-title-s text-text-default">{title}</h3>
      <div className="flex flex-col gap-1 text-body-s text-text-body">
        {children}
      </div>
    </div>
  );
}
