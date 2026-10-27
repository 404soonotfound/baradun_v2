"use client";

import Link from "next/link";
import { useTranslations } from "next-intl";
import { useId } from "react";

import { BeachRow } from "@/components/beach-row";
import type { BeachSummary } from "@/lib/beach-summary";
import { localizedPath, type Locale } from "@/lib/i18n";
import { formatKm, joinMeta } from "@/lib/meta-join";
import { kstStamp } from "@/lib/snapshot/clock";
import { useMetaText } from "@/lib/snapshot/use-meta-text";
import { useTimeText } from "@/lib/snapshot/use-time-text";
import type { BeachView } from "@/lib/snapshot/view";

// 가까운 특보 없는 해변 (BRD-32 · 노션 2장 DET 3, 결정 기록 9장 대안 해변)
// 고르는 규칙은 lib/alternatives.ts. 여기서는 그리기만. '추천' 표현을 쓰지 않음
// 판단 카드가 '특보 없음'이 아닐 때만 부르는 쪽이 보여줌
// 행마다 '특보 없음' 근거(이 해변 특보구역 · 기관 · 확인 시각), 카드 끝에 현장 우선 문구(공통 규칙)
export function AltBeaches({
  locale,
  items,
  nowMs,
}: {
  locale: Locale;
  // warningSource: 그 해변 특보 확인 기관(예: 기상청, status warning.source)
  items: (BeachSummary & {
    distanceKm: number;
    view: BeachView;
    warningSource: string | null;
  })[];
  nowMs: number;
}) {
  const t = useTranslations();
  const titleId = useId();
  const { measuredAgoText } = useTimeText();
  const { agencyText } = useMetaText();

  return (
    <section
      aria-labelledby={titleId}
      className="flex flex-col gap-2.5 rounded-card bg-bg-surface py-4 shadow-card"
    >
      <h2 id={titleId} className="px-4 text-title-s text-text-default">
        {t("detail.alt.title")}
      </h2>
      {items.length === 0 ? (
        <p className="px-4 text-body-s text-text-body">
          {t("detail.alt.none")} ·{" "}
          <Link
            href={localizedPath(locale, "/explore/")}
            className="inline-flex min-h-touch items-center font-bold text-brand-default underline"
          >
            {t("detail.alt.explore")}
          </Link>
        </p>
      ) : (
        <ul className="divide-y divide-border-default">
          {items.map((beach) => {
            // 고르는 단계에서 '특보 없음'(ready)만 남음. 타입을 좁히려고 한 번 더 확인
            if (beach.view.kind !== "ready") return null;
            const wave = beach.view.metrics.waveHeight;
            // '특보 없음'은 범위·기관·확인 시각이 모두 있을 때만 보여줌. 하나라도 없으면 행을 두지 않음
            const time = kstStamp(beach.view.confirmedAt, nowMs);
            if (!time || !beach.warningSource) return null;
            return (
              <li key={beach.id}>
                <BeachRow
                  href={localizedPath(locale, `/spots/${beach.slug}/`)}
                  name={beach.name}
                  // 좁은 PC 오른쪽 열에서도 거리·측정 시각이 잘리지 않게 지역은 뺌
                  meta={joinMeta([
                    formatKm(beach.distanceKm) &&
                      `${formatKm(beach.distanceKm)}km`,
                    wave.kind === "value"
                      ? measuredAgoText(wave.observedAt, nowMs)
                      : null,
                  ])}
                  wave={wave}
                  detail={t("detail.verdict.clearBasis", {
                    source: agencyText(beach.warningSource),
                    time,
                  })}
                  status={beach.view.badge}
                />
              </li>
            );
          })}
        </ul>
      )}
      <p className="px-4 text-caption text-text-muted">
        {t("safety.finalCall")}
      </p>
    </section>
  );
}
