import {
  CircleCheck,
  CircleQuestionMark,
  Clock,
  TriangleAlert,
} from "lucide-react";
import Link from "next/link";
import { getTranslations } from "next-intl/server";
import type { ReactNode } from "react";

import { BackButton } from "@/components/detail/back-button";
import { Call119 } from "@/components/detail/detail-sections";
import { ExternalLink } from "@/components/info/info-blocks";
import { StatusBadge } from "@/components/ui/status-badge";
import type { VerdictTone } from "@/lib/badge-tone";
import { cn } from "@/lib/cn";
import { localizedPath, type Locale } from "@/lib/i18n";

// 안전·데이터 안내 /guide/ (BRD-36 · 노션 2장 GUIDE, Figma S_M06_02 179:289 · BRD-129 10/30 사용자 결정 A)
// Figma 구성: 머리(‹ · 가운데 제목) → '이 서비스가 하는 일' 카드 → 배지 카드 → '출처와 갱신' 카드 → 현장 우선 문구
// 노션 GUIDE에만 있는 내용은 Figma 구성 안에 넣음: 확인하는 것(특보 5종·측정 시각·통제)은 '하는 일' 카드 안,
// 파주기 읽는 법·활동별 안전수칙·긴급신고 119는 배지 카드와 출처 카드 사이에 같은 카드 모양으로
// 배지는 실제 사유 글자만(Figma '이용불가 · 특보 이름'처럼 분류를 앞에 두지 않음, Rev.2.2). 예시라서 분류를 계산하지 않음
// 적합도·추천·레벨 기준값은 쓰지 않음(G1). 파주기에 숫자 기준선 없음(B2-파장)
// 출처는 요약만 두고 이용 조건·저작권 고지 원문은 데이터 출처 화면(/about/data)에 그대로 둠

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
    <div className="mx-auto flex w-full max-w-[640px] flex-col gap-3.5 pb-6">
      {/* 머리(Figma hbar 179:291): 뒤로 · 가운데 제목 14 굵게 · 오른쪽 빈자리. Figma는 머리 바로 아래부터 카드(사이 0) */}
      <header className="-mx-2.5 -mb-3.5 grid h-14 grid-cols-[44px_minmax(0,1fr)_44px] items-center">
        <BackButton locale={locale} fallback="/settings/" />
        <h1 className="truncate text-center text-body font-bold text-text-default">
          {tc("pages.guide")}
        </h1>
      </header>

      {/* 이 서비스가 하는 일(Figma 179:300) + 확인하는 것(노션 GUIDE 1) */}
      <Card id="guide-does" title={t("does.title")} large>
        <p className="text-[13.5px] leading-[21.6px] text-text-body">
          {t("does.body")}
        </p>
        <div className="mt-1 flex flex-col gap-3 border-t border-border-default pt-3">
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
        </div>
      </Card>

      {/* 배지가 뜻하는 것(Figma 179:303). 제목은 Figma에 없어 화면 읽기에만 둠 */}
      <section
        aria-labelledby="guide-badges"
        className="overflow-hidden rounded-card bg-bg-surface shadow-card"
      >
        <h2 id="guide-badges" className="sr-only">
          {t("badges.title")}
        </h2>
        <ul className="flex flex-col divide-y divide-border-default">
          {BADGES.map(({ tone, icon, key }) => (
            <li
              key={key}
              className="flex flex-col items-start gap-1.5 px-4 py-[13px]"
            >
              <StatusBadge tone={tone} icon={icon}>
                {t(`badges.${key}`)}
              </StatusBadge>
              <p className="text-label-s text-text-body">
                {t(`badges.${key}Body`)}
              </p>
            </li>
          ))}
        </ul>
      </section>

      {/* 파주기 읽는 법(노션 GUIDE 2) */}
      <Card id="guide-period" title={t("period.title")}>
        <p className="text-label-s text-text-body">{t("period.body")}</p>
        <p className="text-label-s text-text-body">{t("period.note")}</p>
      </Card>

      {/* 활동별 안전수칙(노션 GUIDE 3). 공식 원문 확인 경로를 함께 둠 */}
      <Card id="guide-safety" title={t("safety.title")}>
        <p className="text-label-s text-text-body">{t("safety.intro")}</p>
        {ACTIVITIES.map((activity) => (
          <section
            key={activity}
            aria-labelledby={`guide-safety-${activity}`}
            className="flex flex-col gap-1 border-t border-border-default pt-3"
          >
            <h3
              id={`guide-safety-${activity}`}
              className="text-body-s font-bold text-text-default"
            >
              {t(`safety.${activity}.title`)}
            </h3>
            <ul className="flex list-disc flex-col gap-0.5 pl-5 text-label-s text-text-body">
              {RULES.map((rule) => (
                <li key={rule}>{t(`safety.${activity}.${rule}`)}</li>
              ))}
            </ul>
          </section>
        ))}
        <p className="text-caption text-text-muted">{t("safety.official")}</p>
        <ExternalLink
          href={SAFETY_SOURCE_URL}
          newWindow={tc("common.newWindow")}
        >
          {t("safety.officialLink")}
        </ExternalLink>
      </Card>

      {/* 긴급신고 119(노션 GUIDE 4) */}
      <Call119 />

      {/* 출처와 갱신(Figma 179:344). 이용 조건·고지 원문은 데이터 출처 화면 */}
      <Card id="guide-sources" title={t("sources.title")}>
        <p className="text-label-s leading-[20px] text-text-body">
          {t("sources.body")}
        </p>
        <Link
          href={localizedPath(locale, "/about/data/")}
          className="inline-flex min-h-touch items-center self-start text-body-s font-bold text-brand-default underline-offset-2 hover:underline"
        >
          {t("sources.link")}
        </Link>
      </Card>

      {/* 현장 우선 문구는 화면에 한 번(Figma 179:347) */}
      <p className="text-caption text-text-muted">{tc("safety.finalCall")}</p>
    </div>
  );
}

// 안내 카드(Figma card.stack 179:300·179:344): 안쪽 16, 사이 8, 제목 17(첫 카드) 또는 15
function Card({
  id,
  title,
  large = false,
  children,
}: {
  id: string;
  title: string;
  large?: boolean;
  children: ReactNode;
}) {
  return (
    <section
      aria-labelledby={id}
      className="flex flex-col gap-2 rounded-card bg-bg-surface p-4 shadow-card"
    >
      <h2
        id={id}
        className={cn(
          "text-text-default",
          large ? "text-title-m" : "text-title-s",
        )}
      >
        {title}
      </h2>
      {children}
    </section>
  );
}

// 확인하는 것 한 줄: 13 굵은 제목 + 12.5 설명
function Fact({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <h3 className="text-body-s font-bold text-text-default">{title}</h3>
      <div className="flex flex-col gap-1 text-label-s text-text-body">
        {children}
      </div>
    </div>
  );
}
