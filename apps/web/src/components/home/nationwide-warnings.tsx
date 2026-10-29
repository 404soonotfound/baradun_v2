"use client";

import type { WarningItem } from "@baradun/contracts";
import { ChevronRight, TriangleAlert } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";

import { SectionHead } from "@/components/home/section-head";
import { WarningSheet } from "@/components/warning-sheet";
import { ZoneName } from "@/components/zone-name";
import { AGENCY } from "@/lib/agencies";
import { kstStamp } from "@/lib/snapshot/clock";
import { useNationwideWarnings } from "@/lib/snapshot/nationwide";
import { useBadgeText } from "@/lib/snapshot/use-badge-text";
import { useSnapshot } from "@/lib/snapshot/use-snapshot";
import { useTimeText } from "@/lib/snapshot/use-time-text";
import { useSheet } from "@/lib/use-sheet";

// 전국 해상 특보 파일은 기상청 특보만 담음(계약 NationwideWarningsFile, 기관 칸 없음)
const NATIONWIDE_SOURCE = AGENCY.kma;

// 해상 특보 (노션 2장 HOME 9 · 3장 NoticeList, Figma S_M01_01 '해상 특보')
// '특보 없음'은 범위(전국 해상)·기관(기상청)·확인 시각이 모두 있고 45분 안일 때만(stale 아님)
// 행을 누르면 특보 상세 시트(WARN, BRD-33). 시트는 열 때 고른 특보를 기억해 닫히는 동안에도 내용을 유지
export function NationwideWarnings() {
  const t = useTranslations("home.warnings");
  const tw = useTranslations("warning");
  const warnings = useNationwideWarnings();
  const { nowMs } = useSnapshot();
  const { badgeText, confirmedUntilText } = useBadgeText();
  const { issuedAtText } = useTimeText();
  const sheet = useSheet("warning");
  const [selected, setSelected] = useState<WarningItem | null>(null);

  // [1] 제목 줄 오른쪽 "전국 해상 · 기상청 14:30 확인". 받은 뒤 시각을 알 때만
  const time =
    warnings.kind === "ready" ? kstStamp(warnings.confirmedAt, nowMs) : null;

  return (
    <section aria-labelledby="home-warnings" className="flex flex-col gap-2.5">
      <SectionHead
        id="home-warnings"
        title={t("title")}
        meta={time && t("scope", { time })}
      />
      <div className="overflow-hidden rounded-card bg-bg-surface shadow-card">
        {/* [2] Vue: v-if 3갈래. kind가 갈래를 정함 */}
        {warnings.kind === "loading" && (
          <p role="status" className="px-4 py-3 text-body-s text-text-muted">
            {t("loading")}
          </p>
        )}
        {warnings.kind === "failed" && (
          // 실패 문구: 무슨 일 → 영향 → 다음 행동. '특보 없음'으로 보이지 않게 따로 둠
          <p className="px-4 py-3 text-body-s text-text-body">
            {t("failed")} · {t("failedImpact")} · {t("failedNext")}
          </p>
        )}
        {warnings.kind === "ready" && (
          <>
            {/* [3] 요약 줄 */}
            <p className="border-b border-border-default px-4 py-3 text-body-s text-text-body">
              {warnings.items.length > 0
                ? // t.rich = 문구 안 <b>…</b>를 부품으로 바꿈(Vue i18n의 <i18n-t> 자리)
                  t.rich("count", {
                    count: warnings.items.length,
                    b: (chunks) => (
                      <b className="text-text-default">{chunks}</b>
                    ),
                  })
                : warnings.stale
                  ? t("unconfirmed")
                  : t("none")}
              {warnings.stale && (
                <span className="block text-caption text-text-muted">
                  {confirmedUntilText(warnings.confirmedAt, nowMs)}
                </span>
              )}
            </p>
            {/* [4] 특보 행. Vue: v-for */}
            {warnings.items.length > 0 && (
              <ul>
                {warnings.items.map((item) => (
                  <li
                    // 같은 구역·종류가 두 번 올 수 있어 발표 시각까지 붙임
                    key={`${item.zoneName}-${item.type}-${item.level}-${item.publishedAt}`}
                    className="border-t border-border-default first:border-t-0"
                  >
                    <button
                      type="button"
                      aria-haspopup="dialog"
                      onClick={() => {
                        setSelected(item);
                        sheet.show();
                      }}
                      className="flex min-h-touch w-full items-center gap-3 px-4 py-[11px] text-left hover:bg-bg-subtle focus-visible:-outline-offset-2"
                    >
                      <span
                        aria-hidden="true"
                        className="flex size-[34px] shrink-0 items-center justify-center rounded-icon bg-status-blocked-bg text-status-blocked-fg"
                      >
                        <TriangleAlert size={17} />
                      </span>
                      <span className="flex min-w-0 flex-1 flex-col">
                        {/* "동해중부먼바다 풍랑주의보" / "Wind wave advisory · Nearshore waters of …": 순서는 언어별 문구 키 */}
                        <span className="text-body-s font-bold text-text-default">
                          {tw.rich("zoneLine", {
                            name: badgeText({
                              kind: "warning",
                              type: item.type,
                              level: item.level,
                            }),
                            zone: () => <ZoneName zone={item} />,
                          })}
                        </span>
                        <span className="text-caption text-text-muted">
                          {issuedAtText(item.publishedAt, nowMs)}
                        </span>
                      </span>
                      <ChevronRight
                        aria-hidden="true"
                        size={16}
                        className="shrink-0 text-text-muted"
                      />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </div>
      <WarningSheet
        open={sheet.open}
        onClose={sheet.close}
        item={selected}
        items={warnings.kind === "ready" ? warnings.items : []}
        source={NATIONWIDE_SOURCE}
        confirmedAt={warnings.kind === "ready" ? warnings.confirmedAt : null}
        stale={warnings.kind !== "ready" || warnings.stale}
        nowMs={nowMs}
      />
    </section>
  );
}
