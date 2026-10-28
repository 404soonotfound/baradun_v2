import {
  CircleCheck,
  CircleQuestionMark,
  Clock,
  TriangleAlert,
} from "lucide-react";
import { getTranslations } from "next-intl/server";
import type { ReactNode } from "react";

import { Call119 } from "@/components/detail/detail-sections";
import { ExternalLink, InfoSection } from "@/components/info/info-blocks";
import { StatusBadge } from "@/components/ui/status-badge";
import type { VerdictTone } from "@/lib/badge-tone";
import type { Locale } from "@/lib/i18n";

// 안전·데이터 안내 /guide/ (BRD-36 · 노션 2장 GUIDE)
// 순서: 무엇을 확인하나요(특보 5종·측정 시각·통제·배지) → 파주기 읽는 법 → 활동별 안전수칙 → 긴급신고 119 → 현장 우선 문구
// 적합도·추천·레벨 기준값은 쓰지 않음(G1). 파주기에 숫자 기준선 없음(B2-파장)
// 배지 예시는 화면과 같은 모양(색 + 아이콘 + 단어). 예시라서 분류를 계산하지 않음

// 공식 안전수칙 원문(국민재난안전포털 물놀이 안전수칙). 수칙 문구 확정 전까지 원문 확인 경로로 둠
const SAFETY_SOURCE_URL =
  "https://www.safekorea.go.kr/idsiSFK/neo/sfk/cs/contents/prevent/SDIJKM5129.html?menuSeq=127";

const BADGES: {
  tone: VerdictTone;
  icon: ReactNode;
  key: "clear" | "warning" | "unknown" | "stale";
}[] = [
  { tone: "clear", icon: <CircleCheck size={14} />, key: "clear" },
  { tone: "blocked", icon: <TriangleAlert size={14} />, key: "warning" },
  { tone: "unknown", icon: <CircleQuestionMark size={14} />, key: "unknown" },
  { tone: "stale", icon: <Clock size={14} />, key: "stale" },
];

const ACTIVITIES = ["swimming", "surfing", "scuba"] as const;
const RULES = ["rule1", "rule2", "rule3"] as const;

export async function GuideContent({ locale }: { locale: Locale }) {
  const t = await getTranslations({ locale, namespace: "guide" });
  const tc = await getTranslations({ locale });

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <h1 className="text-title-xl text-text-default">{tc("pages.guide")}</h1>
        <p className="text-body text-text-body">{t("intro")}</p>
      </div>

      <InfoSection id="guide-check" title={t("check.title")}>
        <Fact title={t("check.warningTitle")}>
          <p>{t("check.warningBody")}</p>
          <p>{t("check.nearby")}</p>
        </Fact>
        <Fact title={t("check.timeTitle")}>
          <p>{t("check.timeBody")}</p>
          <p>{t("check.noStation")}</p>
        </Fact>
        <Fact title={t("check.controlTitle")}>
          <p>{t("check.controlBody")}</p>
        </Fact>
      </InfoSection>

      <InfoSection id="guide-badges" title={t("badges.title")}>
        <ul className="flex flex-col gap-3">
          {BADGES.map(({ tone, icon, key }) => (
            <li key={key} className="flex flex-col items-start gap-1">
              <StatusBadge tone={tone} icon={icon}>
                {t(`badges.${key}`)}
              </StatusBadge>
              <p className="text-body-s text-text-body">
                {t(`badges.${key}Body`)}
              </p>
            </li>
          ))}
        </ul>
      </InfoSection>

      <InfoSection id="guide-period" title={t("period.title")}>
        <p className="text-body-s text-text-default">{t("period.body")}</p>
        <p className="text-body-s text-text-body">{t("period.note")}</p>
      </InfoSection>

      <InfoSection id="guide-safety" title={t("safety.title")}>
        <p className="text-body-s text-text-body">{t("safety.intro")}</p>
        <div className="grid gap-3 lg:grid-cols-3">
          {ACTIVITIES.map((activity) => (
            <section
              key={activity}
              aria-labelledby={`guide-safety-${activity}`}
              className="flex flex-col gap-2 rounded-card border border-border-default p-3"
            >
              <h3
                id={`guide-safety-${activity}`}
                className="text-title-s text-text-default"
              >
                {t(`safety.${activity}.title`)}
              </h3>
              <ul className="flex list-disc flex-col gap-1 pl-5 text-body-s text-text-body">
                {RULES.map((rule) => (
                  <li key={rule}>{t(`safety.${activity}.${rule}`)}</li>
                ))}
              </ul>
            </section>
          ))}
        </div>
        <p className="text-caption text-text-muted">{t("safety.official")}</p>
        <ExternalLink
          href={SAFETY_SOURCE_URL}
          newWindow={tc("common.newWindow")}
        >
          {t("safety.officialLink")}
        </ExternalLink>
      </InfoSection>

      <Call119 />

      <p
        role="note"
        className="rounded-card bg-brand-weak px-4 py-3 text-body-s font-bold text-text-default"
      >
        {tc("safety.finalCall")}
      </p>
    </div>
  );
}

function Fact({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <h3 className="text-title-s text-text-default">{title}</h3>
      <div className="flex flex-col gap-1 text-body-s text-text-body">
        {children}
      </div>
    </div>
  );
}
