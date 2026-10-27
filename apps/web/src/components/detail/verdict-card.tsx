"use client";

import {
  CalendarX,
  CircleCheck,
  CircleQuestionMark,
  Clock,
  RotateCw,
  TriangleAlert,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { useId, useState, type ReactNode } from "react";

import { ReasonBadge } from "@/components/reason-badge";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusBadge } from "@/components/ui/status-badge";
import { joinMeta } from "@/lib/meta-join";
import { kstStamp } from "@/lib/snapshot/clock";
import type { Basis, DetailInfo } from "@/lib/snapshot/detail";
import { useBadgeText } from "@/lib/snapshot/use-badge-text";
import { getSnapshotState, refreshSnapshot } from "@/lib/snapshot/use-snapshot";
import { useMetaText } from "@/lib/snapshot/use-meta-text";
import { useTimeText } from "@/lib/snapshot/use-time-text";
import {
  deriveBeachView,
  type BadgeLabel,
  type BeachView,
} from "@/lib/snapshot/view";

// 판단 카드 (BRD-32 · 노션 2장 DET 2, 3장 VerdictCard, 5장 우선순위)
// ① 사유 배지(+ 운영 기간 아님 정보 배지) ② 결론 문장 ③ 근거(범위 → 기관 → 시각) ④ 사유 상자
// ⑤ 확인한 것 3칸(특보 · 측정 시각 · 파고) ⑥ 현장 우선 문구. 분류는 view 그대로(G1)
// '다음 측정 예정 시각'은 10/22 결정(nextExpectedAt 출시에서 항상 null)으로 두지 않음

// 'YYYY-MM-DD' → '7/10'. 운영 기간 표시용(날짜만, 시간대 없음)
function monthDay(date: string): string {
  const [, month, day] = date.split("-");
  return `${Number(month)}/${Number(day)}`;
}

export function VerdictCard({
  beachId,
  view,
  detail,
  nowMs,
  children,
}: {
  beachId: string;
  view: BeachView;
  detail: DetailInfo;
  nowMs: number;
  // ⑥ 아래에 덧붙일 것(BRD-33의 '자세히' 등)
  children?: ReactNode;
}) {
  const t = useTranslations();
  const { badgeText, confirmedUntilText } = useBadgeText();
  const { measuredAgoText, issuedAtText } = useTimeText();
  const { agencyText } = useMetaText();
  const titleId = useId();

  if (view.kind !== "ready") {
    return (
      <section
        aria-busy="true"
        className="flex flex-col gap-3 rounded-card bg-bg-surface p-5 shadow-card"
      >
        <Skeleton className="h-badge w-24 rounded-badge" />
        <Skeleton className="h-7 w-3/4" />
        <Skeleton className="h-4 w-1/2" />
        <p className="text-caption text-text-muted">{t("safety.finalCall")}</p>
      </section>
    );
  }

  // ② 결론 문장(5장 우선순위 표). 이용불가는 특보 이름 그대로 + 보조 문장(S17)
  function sentence(label: BadgeLabel): string {
    switch (label.kind) {
      case "warning":
        return t("verdict.warning.sentence", { name: badgeText(label) });
      case "restricted":
        return t("verdict.restricted.sentence");
      case "warning_unknown":
        return t("verdict.unknownWarning.sentence");
      case "observation_delayed":
        return t("verdict.stale.sentence");
      case "unconfirmed":
        return t("verdict.unconfirmed.sentence");
      case "clear":
        return t("verdict.clear.sentence");
    }
  }

  // ③ 근거 줄. B5면 'HH:MM 확인 · 이후 확인 못 함'만, '특보 없음'은 범위·기관·확인 시각이 모두 있을 때만
  function basisText(basis: Basis): string | null {
    let time: string | null = null;
    const stamp = kstStamp(basis.at, nowMs);
    if (basis.code === "warning") time = issuedAtText(basis.at, nowMs);
    // 특보 확인 못 함: at = 마지막 확인 시각(10/22 ③) → 확인된 것처럼 읽히지 않게 '이후 확인 못 함'을 붙임
    else if (basis.code === "warning_unknown")
      time = confirmedUntilText(basis.at, nowMs);
    else if (stamp) time = t("detail.verdict.basisObserved", { time: stamp });
    return joinMeta([
      basis.scope,
      basis.source && agencyText(basis.source),
      time,
    ]);
  }
  const lines: string[] = [];
  if (view.stale) {
    lines.push(confirmedUntilText(view.confirmedAt, nowMs));
  } else if (view.category === "clear") {
    const time = kstStamp(view.confirmedAt, nowMs);
    if (time && detail.warningSource) {
      lines.push(
        t("detail.verdict.clearBasis", {
          source: agencyText(detail.warningSource),
          time,
        }),
      );
    }
  } else {
    for (const basis of detail.basis) {
      const line = basisText(basis);
      if (line) lines.push(line);
    }
  }

  const blocked = view.category === "unavailable";
  const wave = view.metrics.waveHeight;
  // ⑤ 측정 시각·파고 칸 글자. 값이 없으면 세 가지로 구분(가까운 관측 없음 / 늦어짐 / –)
  const missing =
    wave.kind === "none"
      ? t("observation.none")
      : wave.kind === "delayed"
        ? t("observation.delayedShort")
        : null;
  const warningCell = blocked
    ? { icon: "blocked" as const, text: t("detail.verdict.warningActive") }
    : detail.warningConfirmedNone
      ? { icon: "clear" as const, text: t("detail.verdict.warningNone") }
      : { icon: "unknown" as const, text: t("detail.verdict.warningUnknown") };

  return (
    <section
      aria-labelledby={titleId}
      className="flex flex-col gap-3 rounded-card bg-bg-surface p-5 shadow-card"
    >
      {/* ① 배지. 정보 배지는 판단 배지 오른쪽(분류 영향 없음, N4) */}
      <div className="flex flex-wrap items-center gap-2">
        <ReasonBadge label={view.badge} />
        {detail.offSeason && (
          <StatusBadge tone="info" icon={<CalendarX size={14} />}>
            {t("info.offSeason")}
          </StatusBadge>
        )}
        {detail.offSeason && (
          <span className="text-caption text-text-muted">
            {t("detail.offSeason", {
              from: monthDay(detail.offSeason.openFrom),
              to: monthDay(detail.offSeason.openUntil),
            })}
          </span>
        )}
      </div>

      {/* ② 결론. 상태가 바뀌면 결론만 읽어 줌(3장 접근성) */}
      <div aria-live="polite">
        <h2
          id={titleId}
          className="text-[20px] leading-snug font-bold text-text-default lg:text-[23px]"
        >
          {sentence(view.badge)}
        </h2>
        {blocked && (
          <p className="mt-1 text-body text-text-body">{t("verdict.avoid")}</p>
        )}
      </div>

      {/* ③ 근거 */}
      {lines.length > 0 && (
        <ul className="flex flex-col gap-0.5 text-caption text-text-muted">
          {lines.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      )}

      {/* ④ 사유 상자 */}
      <ReasonBox beachId={beachId} view={view} detail={detail} nowMs={nowMs} />

      {/* ⑤ 확인한 것 */}
      <div>
        <h3 className="text-caption font-bold text-text-muted">
          {t("detail.verdict.checked")}
        </h3>
        <dl className="mt-1.5 grid grid-cols-3 gap-2">
          <CheckedCell
            label={t("detail.verdict.checkedWarning")}
            icon={warningCell.icon}
            text={warningCell.text}
          />
          <CheckedCell
            label={t("detail.verdict.checkedTime")}
            icon={wave.kind === "value" ? "clear" : "stale"}
            text={
              wave.kind === "value"
                ? (measuredAgoText(wave.observedAt, nowMs) ?? "–")
                : (missing ?? "–")
            }
          />
          <CheckedCell
            label={t("detail.verdict.checkedWave")}
            icon={wave.kind === "value" ? "clear" : "stale"}
            text={
              wave.kind === "value"
                ? t("detail.verdict.waveValue", { value: wave.value })
                : (missing ?? "–")
            }
          />
        </dl>
      </div>

      {children}

      {/* ⑥ 현장 우선 문구 */}
      <p className="border-t border-border-default pt-3 text-caption text-text-muted">
        {t("safety.finalCall")}
      </p>
    </section>
  );
}

const CELL_ICON = {
  clear: <CircleCheck size={16} className="text-status-clear-fg" />,
  blocked: <TriangleAlert size={16} className="text-status-blocked-fg" />,
  unknown: <CircleQuestionMark size={16} className="text-status-unknown-fg" />,
  stale: <Clock size={16} className="text-status-stale-fg" />,
};

// 확인한 것 한 칸: 작은 상태 아이콘 + 단어(색만으로 구분하지 않음)
function CheckedCell({
  label,
  icon,
  text,
}: {
  label: string;
  icon: keyof typeof CELL_ICON;
  text: string;
}) {
  const t = useTranslations("home.near");
  return (
    <div className="flex flex-col gap-1 rounded-input bg-bg-subtle px-2.5 py-2">
      <dt className="flex items-center gap-1 text-caption text-text-muted">
        <span aria-hidden="true" className="inline-flex">
          {CELL_ICON[icon]}
        </span>
        {label}
      </dt>
      <dd className="text-body-s font-bold text-text-default">
        {text === "–" ? (
          <>
            <span aria-hidden="true">–</span>
            <span className="sr-only">{t("noValue")}</span>
          </>
        ) : (
          text
        )}
      </dd>
    </div>
  );
}

// 사유 상자(3장 VerdictCard ④). 특보: 적용 구역·발효·영향 활동 / 특보 확인 못 함: 다시 확인하기 /
// 관측 지연: 자동 재확인 안내. '특보 없음'은 상자 없음
function ReasonBox({
  beachId,
  view,
  detail,
  nowMs,
}: {
  beachId: string;
  view: Extract<BeachView, { kind: "ready" }>;
  detail: DetailInfo;
  nowMs: number;
}) {
  const t = useTranslations("detail.verdict");
  const { badgeText } = useBadgeText();
  const [rechecking, setRechecking] = useState(false);
  const [announcement, setAnnouncement] = useState("");

  async function recheck() {
    if (rechecking) return;
    setRechecking(true);
    setAnnouncement("");
    try {
      await refreshSnapshot();
    } catch {
      // 결과는 아래에서 지금 상태로 판단
    } finally {
      setRechecking(false);
    }
    const after = deriveBeachView(
      { id: beachId, hidden: false },
      getSnapshotState(),
    );
    if (after.kind === "ready" && after.badge.kind === "warning_unknown") {
      setAnnouncement(t("recheckFailed"));
    }
  }

  if (view.category === "unavailable" && detail.warnings.length > 0) {
    return (
      <ul className="flex flex-col gap-2">
        {detail.warnings.map((item) => (
          <li
            key={`${item.zoneName}-${item.type}-${item.level}-${item.publishedAt}`}
            className="rounded-input bg-status-blocked-bg px-3.5 py-3 text-body-s text-text-default"
          >
            <p className="font-bold text-status-blocked-fg">
              {badgeText({
                kind: "warning",
                type: item.type,
                level: item.level,
              })}
            </p>
            <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
              <dt className="text-text-muted">{t("zone")}</dt>
              <dd>{item.zoneName}</dd>
              <dt className="text-text-muted">{t("effectiveFrom")}</dt>
              <dd>{kstStamp(item.effectiveFrom, nowMs) ?? "–"}</dd>
              <dt className="text-text-muted">{t("affects")}</dt>
              <dd>{t("allActivities")}</dd>
            </dl>
          </li>
        ))}
      </ul>
    );
  }

  if (view.badge.kind === "warning_unknown") {
    return (
      <div className="flex flex-col gap-1">
        {/* disabled 대신 aria-disabled: 확인하는 동안에도 포커스가 버튼에 남음 */}
        <button
          type="button"
          onClick={() => void recheck()}
          aria-disabled={rechecking}
          className="flex h-touch items-center justify-center gap-2 rounded-button border border-border-strong text-body-s font-bold text-text-default hover:bg-bg-subtle aria-disabled:opacity-60"
        >
          <RotateCw aria-hidden="true" size={16} />
          {rechecking ? t("rechecking") : t("recheck")}
        </button>
        <p role="status" className="text-caption text-text-muted empty:hidden">
          {announcement}
        </p>
      </div>
    );
  }

  if (view.badge.kind === "observation_delayed") {
    return (
      <p className="rounded-input bg-status-stale-bg px-3.5 py-3 text-body-s text-status-stale-fg">
        {t("autoRecheck")}
      </p>
    );
  }

  return null;
}
