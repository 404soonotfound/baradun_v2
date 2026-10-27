"use client";

import { TriangleAlert } from "lucide-react";
import { useTranslations } from "next-intl";

import { SectionHead } from "@/components/home/section-head";
import { kstStamp } from "@/lib/snapshot/clock";
import { useNationwideWarnings } from "@/lib/snapshot/nationwide";
import { useBadgeText } from "@/lib/snapshot/use-badge-text";
import { useSnapshot } from "@/lib/snapshot/use-snapshot";
import { useTimeText } from "@/lib/snapshot/use-time-text";

// 해상 특보 (노션 2장 HOME 9 · 3장 NoticeList, Figma S_M01_01 '해상 특보')
// '특보 없음'은 범위(전국 해상)·기관(기상청)·확인 시각이 모두 있고 45분 안일 때만(stale 아님)
// 행을 누르면 특보 상세 시트(WARN)가 열려야 함 → BRD-33에서 연결. 지금은 누를 수 없는 행
export function NationwideWarnings() {
  const t = useTranslations("home.warnings");
  const warnings = useNationwideWarnings();
  const { nowMs } = useSnapshot();
  const { badgeText, confirmedUntilText } = useBadgeText();
  const { issuedAtText } = useTimeText();

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
          // 실패 문구: 무슨 일 → 다음 행동. '특보 없음'으로 보이지 않게 따로 둠
          <p className="px-4 py-3 text-body-s text-text-body">
            {t("failed")} · {t("failedNext")}
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
                    className="flex items-center gap-3 border-t border-border-default px-4 py-[11px] first:border-t-0"
                  >
                    <span
                      aria-hidden="true"
                      className="flex size-[34px] shrink-0 items-center justify-center rounded-icon bg-status-blocked-bg text-status-blocked-fg"
                    >
                      <TriangleAlert size={17} />
                    </span>
                    <span className="flex min-w-0 flex-col">
                      {/* "동해중부먼바다 풍랑주의보": 구역 원문 + 종류·단계 문구 키 */}
                      <span className="text-body-s font-bold text-text-default">
                        {item.zoneName}{" "}
                        {badgeText({
                          kind: "warning",
                          type: item.type,
                          level: item.level,
                        })}
                      </span>
                      <span className="text-caption text-text-muted">
                        {issuedAtText(item.publishedAt, nowMs)}
                      </span>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </div>
    </section>
  );
}
