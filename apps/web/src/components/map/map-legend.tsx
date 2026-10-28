"use client";

import { useTranslations } from "next-intl";

import type { VerdictTone } from "@/lib/badge-tone";
import { cn } from "@/lib/cn";
import { MARKER_TONE } from "./beach-markers";

// 지도 범례 (BRD-30 · 노션 2장 EXP-M '범례 4종', 4장 데스크톱 '이용불가 / 판단불가 묶음')
// 마커와 같은 색 + 아이콘 + 단어. 아래에 '특보 없음' 범위·기관·확인 시각(지도에 특보 없음 마커가 있을 때) + 현장 우선 문구
const TONES: VerdictTone[] = ["clear", "blocked", "unknown", "stale"];

export function MapLegend({
  clearScope,
  className,
}: {
  // "특보 없음: 각 해변 특보구역 · 기상청 14:30 확인". 지도에 특보 없음 마커가 없으면 null
  clearScope: string | null;
  className?: string;
}) {
  const t = useTranslations();
  return (
    <div
      className={cn(
        "flex flex-col gap-1 rounded-card bg-bg-surface p-2.5 text-caption shadow-card",
        className,
      )}
    >
      <p className="sr-only">{t("map.legend.label")}</p>
      <ul className="flex flex-wrap gap-x-3 gap-y-1 text-text-default">
        {TONES.map((tone) => {
          const { circle, Icon } = MARKER_TONE[tone];
          return (
            <li key={tone} className="flex items-center gap-1">
              <span
                aria-hidden="true"
                className={cn(
                  "flex size-4 items-center justify-center rounded-full border",
                  circle,
                )}
              >
                <Icon size={11} strokeWidth={2.5} />
              </span>
              {t(`map.legend.${tone}`)}
            </li>
          );
        })}
      </ul>
      {clearScope && <p className="text-text-muted">{clearScope}</p>}
      <p className="text-text-muted">{t("safety.finalCall")}</p>
    </div>
  );
}
