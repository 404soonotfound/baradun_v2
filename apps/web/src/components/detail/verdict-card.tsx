"use client";

import {
  CalendarX,
  ChevronRight,
  CircleCheck,
  CircleQuestionMark,
  Clock,
  RotateCw,
  TriangleAlert,
} from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { useId, useState, type ReactNode } from "react";

import type { Beach, WarningItem } from "@baradun/contracts";
import { shownMetric } from "@/components/detail/sea-card";
import { ReasonBadge } from "@/components/reason-badge";
import { KmaSourceNote } from "@/components/source-note";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusBadge } from "@/components/ui/status-badge";
import { ZoneName } from "@/components/zone-name";
import { joinMeta, META_SEPARATOR } from "@/lib/meta-join";
import { kstStamp } from "@/lib/snapshot/clock";
import {
  warningCheckState,
  type Basis,
  type DetailInfo,
} from "@/lib/snapshot/detail";
import { useBadgeText } from "@/lib/snapshot/use-badge-text";
import { getSnapshotState, refreshSnapshot } from "@/lib/snapshot/use-snapshot";
import { useMetaText } from "@/lib/snapshot/use-meta-text";
import type { Locale } from "@/lib/i18n";
import { zoneScopeText } from "@/lib/zone-name";
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

// 근거 줄 하나. text는 겹침 확인·React key, node는 화면에 그리는 것
type BasisLine = { text: string; node: ReactNode };

// 'YYYY-MM-DD' → '7/10'. 운영 기간 표시용(날짜만, 시간대 없음)
function monthDay(date: string): string {
  const [, month, day] = date.split("-");
  return `${Number(month)}/${Number(day)}`;
}

export function VerdictCard({
  beachId,
  view,
  detail,
  stations,
  nowMs,
  kmaSource,
  onOpenWarning,
  children,
}: {
  beachId: string;
  view: BeachView;
  detail: DetailInfo;
  stations: Beach["stations"];
  nowMs: number;
  // 배지(특보·관측을 가공한 분류) 아래 기상청 출처 줄을 둘지(BRD-113, showsKmaSource)
  kmaSource: boolean;
  // 사유 상자의 특보 항목에서 특보 상세 시트(WARN, BRD-33) 열기
  onOpenWarning?: (item: WarningItem) => void;
  // ⑥ 아래에 덧붙일 것(BRD-33의 '자세히' 등)
  children?: ReactNode;
}) {
  const t = useTranslations();
  const { badgeText, confirmedUntilText } = useBadgeText();
  const { measuredAgoText, issuedAtText } = useTimeText();
  const { agencyText } = useMetaText();
  const locale = useLocale() as Locale;
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

  // ③-1 근거 줄의 범위: 게시 값은 한국어 원문뿐(계약 reasons[].scope)
  // 특보·특보 확인 못 함(해변 바다 구역 이름)은 구역 번역표(없으면 원문 + 원문 표시), 관측 지연은 이 해변 측정소의 같은 언어 이름(못 찾으면 원문)
  // text: 같은 근거 줄을 한 번만 두기 위한 글자. node: 화면에 그릴 것(영어 화면에 남는 한국어 원문은 lang="ko")
  function scopeText(basis: Basis): { text: string; node: ReactNode } | null {
    if (basis.scope === null) return null;
    const scope = basis.scope;
    if (locale === "ko") return { text: scope, node: scope };
    const korean = { text: scope, node: <span lang="ko">{scope}</span> };
    if (basis.code === "warning" || basis.code === "warning_unknown") {
      const zone = zoneScopeText(scope, locale);
      if (!zone.untranslated) return { text: zone.text, node: zone.text };
      return {
        text: t.markup("warning.zoneOriginalInline", {
          zone: () => zone.text,
          note: (chunks) => chunks,
        }),
        node: t.rich("warning.zoneOriginalInline", {
          zone: () => <span lang="ko">{zone.text}</span>,
          note: (chunks) => chunks,
        }),
      };
    }
    if (basis.code === "observation_delayed") {
      const station = Object.values(stations).find(
        (item) => item?.name.ko === scope,
      );
      return station
        ? { text: station.name[locale], node: station.name[locale] }
        : korean;
    }
    return korean;
  }

  // ③ 근거 줄. B5면 'HH:MM 확인 · 이후 확인 못 함'만, '특보 없음'은 범위·기관·확인 시각이 모두 있을 때만
  function basisText(basis: Basis): BasisLine | null {
    let time: string | null = null;
    const stamp = kstStamp(basis.at, nowMs);
    if (basis.code === "warning") time = issuedAtText(basis.at, nowMs);
    // 특보 확인 못 함: at = 마지막 확인 시각(10/22 ③) → 확인된 것처럼 읽히지 않게 '이후 확인 못 함'을 붙임
    else if (basis.code === "warning_unknown")
      time = confirmedUntilText(basis.at, nowMs);
    else if (stamp) time = t("detail.verdict.basisObserved", { time: stamp });
    const scope = scopeText(basis);
    const rest = joinMeta([basis.source && agencyText(basis.source), time]);
    const text = joinMeta([scope?.text, rest]);
    if (text === null) return null;
    if (!scope || scope.text.trim() === "") return { text, node: text };
    return {
      text,
      node: (
        <>
          {scope.node}
          {rest !== null && `${META_SEPARATOR}${rest}`}
        </>
      ),
    };
  }
  const lines: BasisLine[] = [];
  const plain = (text: string): BasisLine => ({ text, node: text });
  if (view.stale) {
    lines.push(plain(confirmedUntilText(view.confirmedAt, nowMs)));
  } else if (view.category === "clear") {
    const time = kstStamp(view.confirmedAt, nowMs);
    if (time && detail.warningSource) {
      lines.push(
        plain(
          t("detail.verdict.clearBasis", {
            source: agencyText(detail.warningSource),
            time,
          }),
        ),
      );
    }
  } else {
    for (const basis of detail.basis) {
      const line = basisText(basis);
      // 같은 구역·기관·시각의 특보 여러 개는 근거 줄이 같음 → 한 번만(React key도 겹치지 않게)
      if (line && !lines.some((item) => item.text === line.text))
        lines.push(line);
    }
  }

  const blocked = view.category === "unavailable";
  // 측정소를 모르는 값은 바다 상태 카드처럼 "–"(출처 없는 값을 보이지 않음)
  const wave = shownMetric(view, stations, "waveHeight");
  // ⑤ 측정 시각·파고 칸 글자. 값이 없으면 세 가지로 구분(가까운 관측 없음 / 늦어짐 / –)
  const missing =
    wave.kind === "none"
      ? t("observation.none")
      : wave.kind === "delayed"
        ? t("observation.delayedShort")
        : null;
  const warningCell = {
    active: {
      icon: "blocked" as const,
      text: t("detail.verdict.warningActive"),
    },
    none: { icon: "clear" as const, text: t("detail.verdict.warningNone") },
    unknown: {
      icon: "unknown" as const,
      text: t("detail.verdict.warningUnknown"),
    },
  }[warningCheckState(view, detail)];

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
            <li key={line.text}>{line.node}</li>
          ))}
        </ul>
      )}

      {/* ④ 사유 상자 */}
      <ReasonBox
        beachId={beachId}
        view={view}
        detail={detail}
        nowMs={nowMs}
        onOpenWarning={onOpenWarning}
      />

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

      {/* ⑥ 현장 우선 문구. 그 아래에 기상청 출처(다른 화면과 같은 자리 규칙, BRD-113 · 기상법) */}
      <div className="flex flex-col gap-0.5 border-t border-border-default pt-3 text-caption text-text-muted">
        <p>{t("safety.finalCall")}</p>
        {kmaSource && <KmaSourceNote variant="status" />}
      </div>
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
  onOpenWarning,
}: {
  beachId: string;
  view: Extract<BeachView, { kind: "ready" }>;
  detail: DetailInfo;
  nowMs: number;
  onOpenWarning: ((item: WarningItem) => void) | undefined;
}) {
  const nameId = useId();
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
    if (
      after.kind === "ready" &&
      after.reasons.some((reason) => reason.kind === "warning_unknown")
    ) {
      setAnnouncement(t("recheckFailed"));
    }
  }

  if (
    view.category === "unavailable" &&
    (detail.warnings.length > 0 || detail.unreadableWarnings > 0)
  ) {
    return (
      <ul className="flex flex-col gap-2">
        {detail.warnings.map((item, index) => (
          <li
            key={`${item.zoneName}-${item.type}-${item.level}-${item.publishedAt}`}
            className="rounded-input bg-status-blocked-bg px-3.5 py-3 text-body-s text-text-default"
          >
            <p
              id={`${nameId}-${index}`}
              className="font-bold text-status-blocked-fg"
            >
              {badgeText({
                kind: "warning",
                type: item.type,
                level: item.level,
              })}
            </p>
            <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
              <dt className="text-text-muted">{t("zone")}</dt>
              <dd>
                <ZoneName zone={item} />
              </dd>
              <dt className="text-text-muted">{t("effectiveFrom")}</dt>
              <dd>{kstStamp(item.effectiveFrom, nowMs) ?? "–"}</dd>
              <dt className="text-text-muted">{t("affects")}</dt>
              <dd>{t("allActivities")}</dd>
            </dl>
            {onOpenWarning && (
              <button
                type="button"
                aria-haspopup="dialog"
                // 특보가 여럿이면 같은 버튼 이름이 반복되므로 특보 이름을 설명으로 붙임
                aria-describedby={`${nameId}-${index}`}
                onClick={() => onOpenWarning(item)}
                className="-mb-2 inline-flex min-h-touch items-center gap-1 font-bold text-status-blocked-fg underline"
              >
                {t("openWarning")}
                <ChevronRight aria-hidden="true" size={16} />
              </button>
            )}
          </li>
        ))}
        {/* 읽을 수 없는 특보: 이름을 지어내지 않고 숨기지도 않음(9.1). 분류는 게시값 그대로(이용불가).
            문구는 노션에 없는 임시안(BRD-32 PR 남은 결정) */}
        {detail.unreadableWarnings > 0 && (
          <li className="rounded-input bg-status-blocked-bg px-3.5 py-3 text-body-s font-bold text-status-blocked-fg">
            {t("unreadableWarning")}
          </li>
        )}
      </ul>
    );
  }

  // 첫 사유가 아니어도(예: 관측 지연 · 특보 확인 못 함) 다시 확인할 수 있게 사유 전체를 봄
  if (view.reasons.some((reason) => reason.kind === "warning_unknown")) {
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
