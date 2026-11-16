"use client";

import Link from "next/link";
import { useTranslations } from "next-intl";

import {
  FavoriteMetricValue,
  FavoriteStarButton,
  FavoriteThumb,
  useFavoriteRowMeta,
  type FavoriteItem,
} from "@/components/favorites/favorite-parts";
import { ReasonBadge } from "@/components/reason-badge";
import { localizedPath, type Locale } from "@/lib/i18n";
import { joinMeta, META_SEPARATOR } from "@/lib/meta-join";
import type { ViewSource } from "@/lib/snapshot/view";

// 즐겨찾기 모바일 해변별 덩어리 (GH-530 · 결정 기록 29장 D29-3, 시안 S_FAVM4)
// 사진 + 이름 · 사유 칩 · 지역 · 거리(· 본 시각) → 구역 · 기관 · 시각 → 파고 · 파주기 · 수온 3칸 → 측정 시각 · 측정소
// 별 버튼은 오른쪽 위 44px(링크 밖)

export function FavoritesList({
  locale,
  items,
  favoriteIds,
  snapshot,
  nowMs,
  onStar,
}: {
  locale: Locale;
  items: readonly FavoriteItem[];
  favoriteIds: ReadonlySet<string>;
  snapshot: ViewSource;
  nowMs: number;
  onStar: (item: FavoriteItem, index: number) => void;
}) {
  return (
    <ul className="divide-y divide-border-default overflow-hidden rounded-card border border-border-default bg-bg-surface shadow-card lg:hidden">
      {items.map((item, index) => (
        <FavoriteBlock
          key={item.beach.id}
          locale={locale}
          item={item}
          isFavorite={favoriteIds.has(item.beach.id)}
          snapshot={snapshot}
          nowMs={nowMs}
          onStar={() => onStar(item, index)}
        />
      ))}
    </ul>
  );
}

function FavoriteBlock({
  locale,
  item,
  isFavorite,
  snapshot,
  nowMs,
  onStar,
}: {
  locale: Locale;
  item: FavoriteItem;
  isFavorite: boolean;
  snapshot: ViewSource;
  nowMs: number;
  onStar: () => void;
}) {
  const t = useTranslations();
  const {
    metaLine,
    warningInfo,
    wave,
    period,
    temp,
    allNone,
    measuredAgo,
    stationNames,
  } = useFavoriteRowMeta(item, snapshot, nowMs);
  const { beach, view } = item;
  const href = localizedPath(locale, `/spots/${beach.slug}/`);
  const measuredLine = joinMeta([measuredAgo, stationNames]);

  return (
    <li className="relative">
      <Link
        href={href}
        className="flex flex-col gap-2.5 p-3.5 focus-visible:-outline-offset-2"
      >
        {/* 오른쪽 위 44px 별 버튼과 겹치지 않게 pr-12로 자리를 비움 */}
        <span className="flex items-center gap-3 pr-12">
          <FavoriteThumb photo={beach.photo} />
          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="flex flex-wrap items-center gap-1.5">
              <span className="text-title-s text-text-default">
                {beach.name}
              </span>
              <ReasonBadge label={view.badge} size="sm" />
            </span>
            {metaLine && (
              <span className="text-caption text-text-muted">{metaLine}</span>
            )}
          </span>
        </span>

        <span className="text-caption text-text-muted">
          {/* zone은 ZoneName 요소일 수 있어 joinMeta 대신 같은 구분자로 이어 붙임 */}
          {warningInfo.zone}
          {META_SEPARATOR}
          {joinMeta([warningInfo.sourceTime, ...warningInfo.extraReasons])}
        </span>

        <span className="rounded-[10px] bg-bg-subtle px-3 py-2.5">
          {allNone ? (
            <span className="text-caption text-text-muted">
              {t("observation.none")}
            </span>
          ) : (
            <span className="grid grid-cols-3 gap-2">
              <span className="flex flex-col gap-0.5">
                <span className="text-caption text-text-muted">
                  {t("observation.metric.waveHeight")}
                </span>
                <FavoriteMetricValue metric={wave} size="sm" />
              </span>
              <span className="flex flex-col gap-0.5">
                <span className="text-caption text-text-muted">
                  {t("observation.metric.wavePeriod")}
                </span>
                <FavoriteMetricValue metric={period} size="sm" />
              </span>
              <span className="flex flex-col gap-0.5">
                <span className="text-caption text-text-muted">
                  {t("observation.metric.waterTemp")}
                </span>
                <FavoriteMetricValue metric={temp} size="sm" />
              </span>
            </span>
          )}
        </span>

        {measuredLine && (
          <span className="text-caption text-text-muted">{measuredLine}</span>
        )}
      </Link>

      {/* 링크 밖에 두어 누를 때 상세로 이동하지 않고 화면 읽기도 꼬이지 않음 */}
      <FavoriteStarButton
        beachId={beach.id}
        beachName={beach.name}
        isFavorite={isFavorite}
        onClick={onStar}
        className="absolute top-2 right-2"
      />
    </li>
  );
}
