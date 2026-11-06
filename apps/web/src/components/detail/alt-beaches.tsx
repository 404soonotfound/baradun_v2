"use client";

import { ChevronRight } from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useId } from "react";

import { MiniWaveChart } from "@/components/home/mini-wave-chart";
import { ReasonBadge } from "@/components/reason-badge";
import { type Activity, activityNameKey } from "@/lib/activity";
import { ALT_MAX_KM } from "@/lib/alternatives";
import type { BeachSummary } from "@/lib/beach-summary";
import { localizedPath, type Locale } from "@/lib/i18n";
import { formatKm, joinMeta } from "@/lib/meta-join";
import { kstStamp } from "@/lib/snapshot/clock";
import { useMetaText } from "@/lib/snapshot/use-meta-text";
import { useTimeText } from "@/lib/snapshot/use-time-text";
import type { BeachView, MetricView } from "@/lib/snapshot/view";

// 가까운 특보 없는 해변 (BRD-32 · 노션 2장 DET 3, 결정 기록 9장 대안 해변 · Figma 177:568, BRD-129)
// 고르는 규칙은 lib/alternatives.ts. 여기서는 그리기만. '추천' 표현을 쓰지 않음
// 판단 카드가 '특보 없음'이 아닐 때만 부르는 쪽이 보여줌
// 제목(카드 밖) → 해변마다 테두리 카드 한 줄(파고 글리프 · 이름 · 거리·측정 시각 · 배지) → '활동과 관계없이 전체 해변 보기'(탐색, D18-11)
// 행마다 '특보 없음' 근거(해변 특보구역 이름 · 기관 · 확인 시각, D18-11)를 한 줄 더 둠(Figma에는 없음, Review guidelines '특보 없음' 근거 규칙)
// 탐색은 활동으로 거르지 않아(D14-15) '서핑 해변 더 보기'처럼 활동으로 거른 목록 링크는 두지 않음
// 현장 우선 문구는 판단 카드에 한 번만(10/30 사용자 결정)
export function AltBeaches({
  locale,
  activity,
  items,
  nowMs,
}: {
  locale: Locale;
  activity: Activity; // 홈에서 고른 활동. 대안은 이 활동이 확인된 해변만(lib/alternatives)
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
  const { agencyText, zonesText } = useMetaText();

  // '특보 없음'은 범위·기관·확인 시각이 모두 있을 때만 보여줌. 하나라도 없으면 행을 두지 않음
  const rows = items.flatMap((beach) => {
    // 고르는 단계에서 '특보 없음'(ready)만 남음. 타입을 좁히려고 한 번 더 확인
    if (beach.view.kind !== "ready") return [];
    const time = kstStamp(beach.view.confirmedAt, nowMs);
    if (!time || !beach.warningSource) return [];
    return [{ beach, view: beach.view, time, source: beach.warningSource }];
  });

  return (
    <section aria-labelledby={titleId} className="flex flex-col gap-2">
      <div className="flex flex-col gap-0.5">
        <h2 id={titleId} className="text-title-m text-text-default">
          {t("detail.alt.title")}
        </h2>
        {/* 상세에서는 활동을 고르지 않아(D18-4) 홈에서 고른 활동으로 거른 것을 알림(시안 M_D4). 수영은 전 해변이라 두지 않음 */}
        {activity !== "swimming" && (
          <p className="text-caption text-text-muted">
            {t("detail.alt.activityNote", {
              activity: t(activityNameKey(activity)),
            })}
          </p>
        )}
      </div>
      {rows.length === 0 ? (
        <p className="rounded-tile border border-brand-border bg-bg-surface px-[15px] py-[13px] text-body-s text-text-body">
          {/* 후보는 있는데 확인 시각을 읽지 못해 모두 뺀 경우는 '없어요'라고 단정하지 않음(리뷰 PR #177) */}
          {items.length > 0
            ? t("detail.alt.unconfirmed")
            : activity === "swimming"
              ? t("detail.alt.none")
              : t("detail.alt.noneActivity", {
                  km: ALT_MAX_KM,
                  activity: t(activityNameKey(activity)),
                })}
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {rows.map(({ beach, view, time, source }) => {
            const wave = view.metrics.waveHeight;
            const km = formatKm(beach.distanceKm);
            return (
              <li key={beach.id}>
                <Link
                  href={localizedPath(locale, `/spots/${beach.slug}/`)}
                  className="flex min-h-20 items-center gap-3 rounded-tile border border-brand-border bg-bg-surface px-[15px] py-[13px] hover:bg-bg-subtle"
                >
                  <WaveGlyph
                    wave={wave}
                    stationId={
                      wave.kind === "value"
                        ? (beach.stations.waveHeight?.id ?? null)
                        : null
                    }
                    nowMs={nowMs}
                  />
                  <span className="flex min-w-0 flex-1 flex-col gap-[3px]">
                    <span className="truncate text-body font-bold text-text-default">
                      {beach.name}
                    </span>
                    <span className="text-caption text-text-muted">
                      {joinMeta([
                        km && t("detail.alt.distance", { km }),
                        wave.kind === "value"
                          ? measuredAgoText(wave.observedAt, nowMs)
                          : null,
                      ])}
                    </span>
                    <span className="text-caption text-text-muted">
                      {t("detail.verdict.clearBasis", {
                        zones: zonesText(beach.warningZones),
                        source: agencyText(source),
                        time,
                      })}
                    </span>
                  </span>
                  <ReasonBadge label={view.badge} />
                </Link>
              </li>
            );
          })}
        </ul>
      )}
      {/* 시안 D안(ActR_D_WXMW): 줄 전체가 누르는 곳(높이 44), 글자 왼쪽 · › 오른쪽 */}
      <Link
        href={localizedPath(locale, "/explore/")}
        className="flex min-h-touch items-center justify-between text-label font-medium text-text-body"
      >
        {t("detail.alt.more")}
        <ChevronRight aria-hidden="true" size={16} />
      </Link>
    </section>
  );
}

// 왼쪽 파고 글리프 54px(Figma gl): 값 + 지난 24시간 미니 선(실제 기록이 있을 때만). 값이 없으면 "–" + 점선
function WaveGlyph({
  wave,
  stationId,
  nowMs,
}: {
  wave: MetricView;
  stationId: string | null;
  nowMs: number;
}) {
  const t = useTranslations();
  if (wave.kind !== "value") {
    return (
      <span className="flex size-[54px] shrink-0 items-center justify-center rounded-[12px] border border-dashed border-border-strong text-text-muted">
        <span aria-hidden="true">–</span>
        <span className="sr-only">
          {wave.kind === "none"
            ? t("observation.none")
            : wave.kind === "delayed"
              ? t("observation.delayed")
              : t("row.noValue")}
        </span>
      </span>
    );
  }
  return (
    <span className="flex size-[54px] shrink-0 flex-col items-center justify-center gap-0.5 rounded-[12px] bg-bg-subtle">
      <span className="text-[14.5px] leading-[21px] font-bold text-text-default">
        <span className="sr-only">{t("observation.metric.waveHeight")} </span>
        {wave.value}
        <span className="text-[10px] font-normal text-text-muted">
          {wave.unit}
        </span>
      </span>
      <span aria-hidden="true" className="block w-[38px]">
        <MiniWaveChart
          stationId={stationId}
          latest={{ t: Date.parse(wave.observedAt), v: wave.value }}
          nowMs={nowMs}
          className="h-3"
        />
      </span>
    </span>
  );
}
