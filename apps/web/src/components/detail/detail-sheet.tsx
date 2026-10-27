"use client";

import type { Beach } from "@baradun/contracts";
import { useTranslations } from "next-intl";

import { shownMetric, shownStation } from "@/components/detail/sea-card";
import { Sheet } from "@/components/ui/sheet";
import { joinMeta } from "@/lib/meta-join";
import { kstStamp } from "@/lib/snapshot/clock";
import { warningCheckState, type DetailInfo } from "@/lib/snapshot/detail";
import { useBadgeText } from "@/lib/snapshot/use-badge-text";
import { useMetaText } from "@/lib/snapshot/use-meta-text";
import { useTimeText } from "@/lib/snapshot/use-time-text";
import type { BeachView } from "@/lib/snapshot/view";

// '자세히' 시트 DET-SH (BRD-33 · 노션 2장 DET-SH, 5장 규칙 4)
// "무엇을 확인했나요" + 안내 → 바다 관련 특보 5종 · 측정 시각 · 출입 통제(확인하지 않아요, G2) · 파고 → 파주기 읽는 법 → 현장 우선 문구
// 확인한 항목마다 범위 → 기관 → 시각. 파장은 표시하지 않음(B2-파장).
// 4항목(시안 S_M04_06): 특보 · 측정 시각 · 출입 통제 · 파고. 파고는 값과 측정 시각만, 맞는지는 사용자가 판단

// 관측값 기관: 파고·수온·바람(sea_obs)·파주기·파향(kma_buoy) 모두 기상청 API허브(결정 기록 B1). 계약에 지표별 기관 칸은 없음
const OBSERVATION_AGENCY = "기상청";

export function DetailSheet({
  open,
  onClose,
  view,
  detail,
  stations,
  nowMs,
}: {
  open: boolean;
  onClose: () => void;
  view: BeachView;
  detail: DetailInfo;
  stations: Beach["stations"];
  nowMs: number;
}) {
  const t = useTranslations();
  const { confirmedUntilText } = useBadgeText();
  const { stationText, agencyText } = useMetaText();
  const { measuredAgoText } = useTimeText();

  const ready = view.kind === "ready" ? view : null;

  // 특보 5종: 상태 단어 + 범위 → 기관 → 시각. 판단 카드 ⑤와 같은 규칙(warningCheckState)
  // 새 정보를 못 받거나 '확인 못 함'이면 'HH:MM 확인 · 이후 확인 못 함'(B5) — 확인한 것처럼 읽히지 않게
  let warningState = t("detail.verdict.warningUnknown");
  let warningMeta: string | null = null;
  if (ready) {
    const state = warningCheckState(ready, detail);
    if (state === "active") warningState = t("detail.verdict.warningActive");
    else if (state === "none") warningState = t("detail.verdict.warningNone");
    const unconfirmed =
      ready.stale ||
      state === "unknown" ||
      ready.reasons.some((reason) => reason.kind === "warning_unknown");
    const time = kstStamp(ready.confirmedAt, nowMs);
    warningMeta = joinMeta([
      t("detailSheet.warningScope"),
      detail.warningSource && agencyText(detail.warningSource),
      unconfirmed || !time
        ? confirmedUntilText(ready.confirmedAt, nowMs)
        : t("detail.verdict.basisChecked", { time }),
    ]);
  }

  // 측정 시각(파고): 측정소 → 기관 → 측정 시각. 값이 없으면 세 가지 구분(가까운 관측 없음 / 늦어짐 / –)
  let waveState = "–";
  let waveMeta: string | null = null;
  if (ready) {
    const wave = shownMetric(ready, stations, "waveHeight");
    const station = shownStation(wave, stations, "waveHeight");
    if (wave.kind === "value") {
      waveState = measuredAgoText(wave.observedAt, nowMs) ?? "–";
      const stamp = kstStamp(wave.observedAt, nowMs);
      waveMeta = joinMeta([
        station && stationText(station),
        agencyText(OBSERVATION_AGENCY),
        stamp && t("detail.verdict.basisObserved", { time: stamp }),
      ]);
    } else if (wave.kind === "none") {
      waveState = t("observation.none");
    } else if (wave.kind === "delayed") {
      waveState = t("observation.delayed");
      waveMeta = joinMeta([
        station && stationText(station),
        agencyText(OBSERVATION_AGENCY),
      ]);
    }
  }

  // 파고: 값만(비교 기준 없음, 3장 VerdictCard). 값이 없으면 측정 시각 칸과 같은 구분
  let waveValue = waveState;
  if (ready) {
    const wave = shownMetric(ready, stations, "waveHeight");
    if (wave.kind === "value") {
      waveValue = t("detail.verdict.waveValue", { value: wave.value });
    }
  }

  const rows = [
    {
      key: "warning",
      title: t("detailSheet.warningTitle"),
      state: warningState,
      body: t("detailSheet.warningBody"),
      meta: warningMeta,
    },
    {
      key: "time",
      title: t("detailSheet.timeTitle"),
      state: waveState,
      body: t("detailSheet.timeBody"),
      meta: waveMeta,
    },
    {
      key: "control",
      title: t("detailSheet.controlTitle"),
      state: t("detailSheet.controlState"),
      body: t("detailSheet.controlBody"),
      meta: null,
    },
    {
      key: "wave",
      title: t("detailSheet.waveTitle"),
      state: waveValue,
      body: t("detailSheet.waveBody"),
      meta: null,
    },
  ];

  return (
    <Sheet open={open} onClose={onClose} title={t("detailSheet.title")}>
      <div className="flex flex-col gap-4 pb-2">
        <p className="text-body-s text-text-body">{t("detailSheet.intro")}</p>
        <ul className="flex flex-col divide-y divide-border-default rounded-input bg-bg-subtle">
          {rows.map((row) => (
            <li key={row.key} className="flex flex-col gap-0.5 px-4 py-3">
              <span className="flex flex-wrap items-baseline justify-between gap-x-3">
                <span className="text-body-s font-bold text-text-default">
                  {row.title}
                </span>
                <span className="text-body-s font-bold text-text-default">
                  {/* 값 없음 "–"은 화면 읽기에 '값 없음'으로(판단 카드 CheckedCell과 같음) */}
                  {row.state === "–" ? (
                    <>
                      <span aria-hidden="true">–</span>
                      <span className="sr-only">{t("home.near.noValue")}</span>
                    </>
                  ) : (
                    row.state
                  )}
                </span>
              </span>
              <span className="text-caption text-text-body">{row.body}</span>
              {row.meta && (
                <span className="text-caption text-text-muted">{row.meta}</span>
              )}
            </li>
          ))}
        </ul>
        <section className="flex flex-col gap-1">
          <h3 className="text-body-s font-bold text-text-default">
            {t("detailSheet.periodTitle")}
          </h3>
          <p className="text-body-s text-text-body">
            {t("detailSheet.periodBody")}
          </p>
        </section>
        <p className="border-t border-border-default pt-3 text-caption text-text-muted">
          {t("safety.finalCall")}
        </p>
      </div>
    </Sheet>
  );
}
