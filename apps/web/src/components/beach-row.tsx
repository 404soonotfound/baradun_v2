import {
  ChevronRight,
  CircleCheck,
  CircleQuestionMark,
  Clock,
  TriangleAlert,
  X,
} from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import type { ReactNode } from "react";

import { badgeTone, type VerdictTone } from "@/lib/badge-tone";
import { cn } from "@/lib/cn";
import { useBadgeText } from "@/lib/snapshot/use-badge-text";
import type { BadgeLabel, MetricView } from "@/lib/snapshot/view";

// 해변 행 (BRD-81 · 컴포넌트 명세 BeachRow, Figma lrow 173:570 · 178:111)
// 왼쪽 파고 글리프 54px · 가운데 3줄(해변명 · 지역·거리·측정 시각 · 사유 또는 값) · 오른쪽 ›
// 행 전체가 링크(최소 44px). 행 안에는 배지 상자를 두지 않음(상태는 아이콘 + 글자 한 줄)
// 24시간 미니 선은 파고 이력(history.json)이 필요해 상세 차트(BRD-32)와 함께 붙임

// 상태 글자 줄(withStatus)의 색·아이콘. 배지와 같은 4가지 색 이름(badgeTone)을 씀
const STATUS: Record<
  VerdictTone,
  { text: string; bar: string; icon: ReactNode }
> = {
  clear: {
    text: "text-status-clear-fg",
    bar: "shadow-[inset_4px_0_0_var(--color-status-clear-fg)]",
    icon: <CircleCheck size={13} />,
  },
  blocked: {
    text: "text-status-blocked-fg",
    bar: "shadow-[inset_4px_0_0_var(--color-status-blocked-fg)]",
    icon: <TriangleAlert size={13} />,
  },
  unknown: {
    text: "text-status-unknown-fg",
    bar: "shadow-[inset_4px_0_0_var(--color-status-unknown-fg)]",
    icon: <CircleQuestionMark size={13} />,
  },
  stale: {
    text: "text-status-stale-fg",
    bar: "shadow-[inset_4px_0_0_var(--color-status-stale-fg)]",
    icon: <Clock size={13} />,
  },
};

// removable 변형(최근 본): › 대신 ✕. 둘은 같이 줘야 함(하나만 주면 타입 오류)
type RemoveProps =
  | { onRemove: () => void; removeLabel: string }
  | { onRemove?: undefined; removeLabel?: undefined };

export function BeachRow({
  href,
  name,
  meta,
  wave,
  detail,
  status,
  highlight = false,
  changedFrom = null,
  onRemove,
  removeLabel,
}: {
  href: string;
  // 해변 이름(목록에서는 지역을 뺀 이름. 예: "인구해변")
  name: string;
  // 2줄째: "강원 양양 · 2.1km · 10분 전 측정"(MetaLine과 같은 잇기 규칙)
  meta: string | null;
  // 파고 값(view.metrics.waveHeight). 값이 없으면 "–"와 점선
  wave: MetricView;
  // 3줄째: 값("파고 0.6m · 주기 6초") 또는 이용불가면 특보 이름만(S17)
  detail: string | null;
  // withStatus 변형(가까운 순·즐겨찾기): 왼쪽 4px 상태색 줄 + 상태 글자 줄
  status?: BadgeLabel;
  // highlight 변형(PC 지도에서 고른 해변): 파란 3px 줄 + 연한 배경
  highlight?: boolean;
  // changed 변형: "방금 바뀜 · 이전: ○○"의 ○○
  changedFrom?: string | null;
} & RemoveProps) {
  const t = useTranslations();
  const { badgeText } = useBadgeText();
  const tone = status ? STATUS[badgeTone(status)] : null;
  const removable = onRemove !== undefined;

  return (
    <div
      className={cn(
        "flex items-center",
        tone?.bar,
        highlight &&
          "bg-brand-weak shadow-[inset_3px_0_0_var(--color-brand-default)]",
      )}
    >
      {/* 포커스 바깥선을 안쪽으로 그림: 목록 카드(overflow-hidden)에 바깥쪽 선이 잘리지 않게 */}
      <Link
        href={href}
        className="flex min-h-touch min-w-0 flex-1 items-center gap-3 py-[13px] pr-3 pl-3.5 focus-visible:-outline-offset-2"
      >
        {/* 값이 없을 때 읽어 줄 이유: 측정소 없음(none)과 잠깐 빠짐·늦음(hidden)을 구분 */}
        <WaveGlyph
          wave={wave}
          metric={t("observation.metric.waveHeight")}
          label={
            wave.kind === "none" ? t("observation.none") : t("row.noValue")
          }
        />
        <span className="flex min-w-0 flex-1 flex-col gap-[3px]">
          <span className="truncate text-title-s text-text-default">
            {name}
          </span>
          {meta && (
            <span className="truncate text-caption text-text-muted">
              {meta}
            </span>
          )}
          {status && tone && (
            <span
              className={cn(
                "flex items-center gap-1 text-body-s font-bold",
                tone.text,
              )}
            >
              <span aria-hidden="true">{tone.icon}</span>
              {badgeText(status)}
            </span>
          )}
          {detail && (
            <span className="truncate text-body-s text-text-body">
              {detail}
            </span>
          )}
          {changedFrom && (
            <span className="text-caption font-bold text-brand-default">
              {t("row.changed", { previous: changedFrom })}
            </span>
          )}
        </span>
        {!removable && (
          <ChevronRight
            aria-hidden="true"
            size={16}
            className="shrink-0 text-text-muted"
          />
        )}
      </Link>
      {/* ✕는 링크 밖에 둠: 링크 안에 버튼이 있으면 누를 때 둘 다 반응하고 화면 읽기도 꼬임 */}
      {removable && (
        <button
          type="button"
          aria-label={removeLabel}
          onClick={onRemove}
          className="mr-1.5 flex size-touch shrink-0 items-center justify-center rounded-full text-text-muted focus-visible:-outline-offset-2"
        >
          <X aria-hidden="true" size={16} />
        </button>
      )}
    </div>
  );
}

// 왼쪽 파고 글리프 54px. 값이 있으면 "0.6m", 없으면 "–" + 점선(0이나 정상으로 보이지 않게)
// metric: 값 앞에 숨겨 읽어 줄 지표 이름("파고"). 없으면 링크 이름이 "0.6m 인구해변"처럼 뜻 없이 읽힘
function WaveGlyph({
  wave,
  metric,
  label,
}: {
  wave: MetricView;
  metric: string;
  label: string;
}) {
  if (wave.kind !== "value") {
    return (
      <span className="flex size-[54px] shrink-0 items-center justify-center rounded-[12px] border border-dashed border-border-strong text-text-muted">
        <span aria-hidden="true">–</span>
        {/* "–"만으로는 뜻이 안 읽혀서 숨긴 글자로 이유를 붙임 */}
        <span className="sr-only">{label}</span>
      </span>
    );
  }
  return (
    <span className="flex size-[54px] shrink-0 items-center justify-center rounded-[12px] bg-bg-subtle">
      <span className="text-[14.5px] font-bold text-text-default">
        <span className="sr-only">{metric} </span>
        {wave.value}
        <span className="text-[10px] font-normal text-text-muted">
          {wave.unit}
        </span>
      </span>
    </span>
  );
}
