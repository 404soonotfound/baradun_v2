"use client";

import { ArrowRight } from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";

import { MARKER_TONE } from "@/components/map/beach-markers";
import { Skeleton } from "@/components/ui/skeleton";
import { badgeTone, type VerdictTone } from "@/lib/badge-tone";
import type { BeachSummary } from "@/lib/beach-summary";
import { cn } from "@/lib/cn";
import { kstStamp } from "@/lib/snapshot/clock";
import { useBadgeText } from "@/lib/snapshot/use-badge-text";
import type { BeachView } from "@/lib/snapshot/view";
import {
  clearCheckedAt,
  NATIONAL_ROW_TONE,
  nationalCounts,
  type NationalRow,
  staleCheckedAt,
} from "@/lib/status-count";

// PC 홈 히어로 오른쪽 '지금 전국 바다' (11/5 홈 v3 시안 ActR_P_V3*, 상태 요약 3장을 대신함)
// 공개 해변 전체를 점으로(색 = 게시된 배지 색, 큰 점 = 지금 보는 범위) + 4가지 묶음 개수 + 근거 줄 → 탐색 지도
// 줄 이름은 노션 D18-5(특보 없음 · 특보 발효 중 · 특보 확인 못 함 · 관측 지연), 아이콘·색은 탐색 지도 범례와 같음
// 개수는 게시된 배지 사유 그대로(G1). 이름과 다른 사유(이용 제한·확인 못 함)는 있을 때만 따로 줄을 둠(lib/status-count nationalCounts)
// 점 그림은 꾸밈(aria-hidden): 같은 정보를 개수 글자가 줌. 바탕 지도 윤곽선은 출처가 정해지지 않아 그리지 않음
const ROWS: NationalRow[] = [
  "clear",
  "warning",
  "restricted",
  "warningUnknown",
  "unconfirmed",
  "delayed",
];
const OPTIONAL_ROWS = new Set<NationalRow>(["restricted", "unconfirmed"]);
const DOT: Record<VerdictTone, string> = {
  clear: "fill-status-clear-fg",
  blocked: "fill-status-blocked-fg",
  unknown: "fill-status-unknown-fg",
  stale: "fill-status-stale-fg",
};
const W = 300;
const H = 330;
const PAD = 10;

// 위경도 → 그림 좌표(등장방형 + 가운데 위도의 cos 보정). 해변 전체가 칸 안에 들어오게 맞춤
function projector(beaches: readonly BeachSummary[]) {
  const lats = beaches.map((b) => b.coords.lat);
  const lngs = beaches.map((b) => b.coords.lng);
  const minLat = Math.min(...lats);
  const maxLat = Math.max(...lats);
  const minLng = Math.min(...lngs);
  const maxLng = Math.max(...lngs);
  const k = Math.cos((((minLat + maxLat) / 2) * Math.PI) / 180);
  const spanX = (maxLng - minLng) * k || 1;
  const spanY = maxLat - minLat || 1;
  const scale = Math.min((W - PAD * 2) / spanX, (H - PAD * 2) / spanY);
  const offX = (W - spanX * scale) / 2;
  const offY = (H - spanY * scale) / 2;
  return (c: { lat: number; lng: number }) => ({
    x: offX + (c.lng - minLng) * k * scale,
    y: offY + (maxLat - c.lat) * scale,
  });
}

export function NationalMapCard({
  href,
  beaches,
  views,
  highlightIds,
  subtitle,
  nowMs,
}: {
  href: string;
  beaches: readonly BeachSummary[]; // 공개 해변 전체(노출 끈 해변 제외)
  views: readonly BeachView[]; // beaches와 같은 순서
  highlightIds: ReadonlySet<string>; // 큰 점(지금 보는 범위). 전국이면 빈 집합
  subtitle: string;
  nowMs: number;
}) {
  const t = useTranslations();
  const { confirmedUntilText } = useBadgeText();
  const loading = views.some((view) => view.kind === "loading");
  const project = projector(beaches);

  const counts = nationalCounts(views);
  const tones = views.map((view) =>
    view.kind === "ready" ? badgeTone(view.badge) : null,
  );
  // 줄 목록: 노션 4줄은 0곳이어도 늘 같은 자리, 이용 제한·확인 못 함은 있을 때만 같은 색 줄 바로 아래
  const rows = ROWS.filter((row) => !OPTIONAL_ROWS.has(row) || counts[row] > 0);

  // 근거 줄: '특보 없음'이 있을 때만 범위·기관·확인 시각. 오래된(B5) 해변이 있으면 'HH:MM 확인 · 이후 확인 못 함'
  const time = counts.clear > 0 ? kstStamp(clearCheckedAt(views), nowMs) : null;
  const stale = staleCheckedAt(views);

  // 작은 점 먼저, 큰 점은 위에
  const dots = beaches
    .map((beach, i) => ({
      id: beach.id,
      ...project(beach.coords),
      tone: tones[i],
      big: highlightIds.has(beach.id),
    }))
    .filter((dot) => dot.tone !== null)
    .sort((a, b) => Number(a.big) - Number(b.big));

  return (
    <Link
      href={href}
      className="group flex w-full items-stretch gap-4 rounded-[20px] border border-border-default bg-bg-surface/85 p-4 shadow-card backdrop-blur hover:bg-bg-surface"
    >
      <svg
        viewBox={`0 0 ${W} ${H}`}
        aria-hidden="true"
        className="h-[230px] w-auto shrink-0"
      >
        {dots.map((dot) => (
          <circle
            key={dot.id}
            cx={dot.x.toFixed(1)}
            cy={dot.y.toFixed(1)}
            r={dot.big ? 5 : 2.6}
            opacity={dot.big ? 1 : 0.55}
            className={DOT[dot.tone!]}
          />
        ))}
      </svg>
      <span className="flex min-w-0 flex-1 flex-col gap-3 py-1">
        <span className="flex flex-col gap-0.5">
          <span className="text-title-s font-bold text-text-default">
            {t("home.map.title")}
          </span>
          <span className="text-caption text-text-muted">{subtitle}</span>
        </span>
        {loading ? (
          // 개수를 미리 보이지 않고 자리와 안내만
          <span role="status" className="flex flex-col gap-2">
            <Skeleton className="h-20 w-full" />
            <span className="text-caption text-text-muted">
              {t("home.region.countLoading")}
            </span>
          </span>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {rows.map((key) => {
              const tone = NATIONAL_ROW_TONE[key];
              const { Icon } = MARKER_TONE[tone];
              return (
                <li
                  key={key}
                  data-national-tone={key}
                  className="flex items-center justify-between gap-2 text-label-s"
                >
                  {/* data-summary-category: 판단 배지가 아니라 묶음 이름(E2E가 '특보 없음' 배지와 구분) */}
                  <span
                    data-summary-category={key}
                    className={cn(
                      "flex items-center gap-1.5 font-bold",
                      tone === "clear" && "text-status-clear-fg",
                      tone === "blocked" && "text-status-blocked-fg",
                      tone === "unknown" && "text-status-unknown-fg",
                      tone === "stale" && "text-status-stale-fg",
                    )}
                  >
                    <Icon aria-hidden="true" size={14} />
                    {t(`home.map.row.${key}`)}
                  </span>
                  <span className="font-bold text-text-default tabular-nums">
                    {t("home.hero.count", { count: counts[key] })}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
        <span className="mt-auto flex flex-col gap-1">
          {/* '특보 없음'이 있으면 범위·기관은 늘 함께. 확인 시각을 모르는 해변이 섞이면 '확인 시각 모름' */}
          {!loading && counts.clear > 0 && (
            <span className="text-[11.5px] text-text-muted">
              {time
                ? t("home.hero.clearScope", { time })
                : t("home.hero.clearScopeNoTime")}
            </span>
          )}
          {!loading && stale !== null && (
            <span className="text-[11.5px] text-text-muted">
              {confirmedUntilText(stale.confirmedAt, nowMs)}
            </span>
          )}
          <span className="inline-flex items-center gap-1 text-label-s font-bold text-brand-default">
            {t("home.map.open")}
            <ArrowRight aria-hidden="true" size={14} />
          </span>
        </span>
      </span>
    </Link>
  );
}
