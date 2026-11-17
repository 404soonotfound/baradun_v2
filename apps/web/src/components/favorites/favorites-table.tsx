"use client";

import { IntentLink } from "@/components/intent-link";
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
import type { ViewSource } from "@/lib/snapshot/view";

// 즐겨찾기 PC 비교 표 (GH-530 · 결정 기록 29장 D29-3, 시안 S_FAVP4·S_FAVP4R)
// 칸: 해변(56×42 사진·이름·지역·거리·본 시각) · 지금 상태 · 특보 구역·기관·시각 · 파고 · 파주기 · 수온 · 측정 · 별
// 측정기가 없으면 파고~측정 네 칸을 합쳐 '가까운 관측 없음'을 표시함

export function FavoritesTable({
  locale,
  tab,
  items,
  favoriteIds,
  snapshot,
  nowMs,
  onStar,
}: {
  locale: Locale;
  tab: "favorites" | "recent";
  items: readonly FavoriteItem[];
  favoriteIds: ReadonlySet<string>;
  snapshot: ViewSource;
  nowMs: number;
  onStar: (item: FavoriteItem, index: number) => void;
}) {
  const t = useTranslations("favorites.table");
  const thClass =
    "px-3 py-3 text-caption font-medium whitespace-nowrap text-text-muted";

  return (
    <div className="hidden overflow-x-auto rounded-card border border-border-default bg-bg-surface shadow-card lg:block">
      <table className="w-full border-collapse text-left">
        <caption className="sr-only">
          {tab === "favorites" ? t("captionFavorites") : t("captionRecent")}
        </caption>
        <thead className="border-b border-border-default bg-bg-subtle/60">
          <tr>
            <th
              scope="col"
              className="py-3 pr-3 pl-4 text-caption font-medium whitespace-nowrap text-text-muted"
            >
              {t("beach")}
            </th>
            <th scope="col" className={thClass}>
              {t("status")}
            </th>
            <th scope="col" className={thClass}>
              {t("warning")}
            </th>
            <th scope="col" className={thClass}>
              {t("waveHeight")}
            </th>
            <th scope="col" className={thClass}>
              {t("wavePeriod")}
            </th>
            <th scope="col" className={thClass}>
              {t("waterTemp")}
            </th>
            <th scope="col" className={thClass}>
              {t("measurement")}
            </th>
            <th scope="col" className="py-3 pr-3 pl-2">
              <span className="sr-only">{t("favorite")}</span>
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border-default">
          {items.map((item, index) => (
            <FavoriteTableRow
              key={item.beach.id}
              locale={locale}
              item={item}
              isFavorite={favoriteIds.has(item.beach.id)}
              snapshot={snapshot}
              nowMs={nowMs}
              onStar={() => onStar(item, index)}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function FavoriteTableRow({
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

  return (
    <tr className="transition-colors hover:bg-bg-subtle/40">
      <th
        scope="row"
        className="py-3.5 pr-3 pl-4 text-left align-middle font-normal"
      >
        <IntentLink
          href={href}
          className="flex min-h-touch items-center gap-3 rounded-[10px] focus-visible:outline-offset-2"
        >
          <FavoriteThumb photo={beach.photo} />
          <span className="flex min-w-0 flex-col">
            <span className="truncate text-title-s text-text-default">
              {beach.name}
            </span>
            {metaLine && (
              <span className="truncate text-caption text-text-muted">
                {metaLine}
              </span>
            )}
          </span>
        </IntentLink>
      </th>

      <td className="px-3 py-3.5 align-middle">
        <ReasonBadge label={view.badge} size="sm" />
        {warningInfo.extraReasons.length > 0 && (
          <p className="mt-1 text-caption text-text-muted">
            {warningInfo.extraReasons.join(" · ")}
          </p>
        )}
      </td>

      <td className="px-3 py-3.5 align-middle text-caption text-text-muted">
        <p className="text-text-body">{warningInfo.zone}</p>
        <p>{warningInfo.sourceTime}</p>
      </td>

      {allNone ? (
        <td
          colSpan={4}
          className="px-3 py-3.5 align-middle text-caption text-text-muted"
        >
          {t("observation.none")}
        </td>
      ) : (
        <>
          <td className="px-3 py-3.5 align-middle">
            <FavoriteMetricValue metric={wave} />
          </td>
          <td className="px-3 py-3.5 align-middle">
            <FavoriteMetricValue metric={period} />
          </td>
          <td className="px-3 py-3.5 align-middle">
            <FavoriteMetricValue metric={temp} />
          </td>
          <td className="px-3 py-3.5 align-middle text-caption text-text-muted">
            {measuredAgo || stationNames ? (
              <>
                {measuredAgo && <p className="text-text-body">{measuredAgo}</p>}
                {stationNames && <p>{stationNames}</p>}
              </>
            ) : (
              <>
                <span aria-hidden="true">–</span>
                <span className="sr-only">{t("home.near.noValue")}</span>
              </>
            )}
          </td>
        </>
      )}

      <td className="py-3.5 pr-3 pl-2 text-right align-middle">
        <FavoriteStarButton
          beachId={beach.id}
          beachName={beach.name}
          isFavorite={isFavorite}
          onClick={onStar}
          className="ml-auto"
        />
      </td>
    </tr>
  );
}
