"use client"; // 기기 저장(즐겨찾기·최근 본)·바다 정보를 쓰므로 브라우저 부품

import { Clock, Star } from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { useMemo, useRef } from "react";

import { BeachRow } from "@/components/beach-row";
import { SituationBanner } from "@/components/situation-banner";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { BeachRowSkeleton } from "@/components/ui/skeleton";
import { Toast, useToast } from "@/components/ui/toast";
import { ViewToggle } from "@/components/ui/view-toggle";
import type { BeachSummary } from "@/lib/beach-summary";
import { cn } from "@/lib/cn";
import {
  clearRecent,
  removeRecent,
  useFavorites,
  useRecent,
} from "@/lib/favorites";
import { localizedPath, type Locale } from "@/lib/i18n";
import { pickSituation, sourceOutage } from "@/lib/situation";
import { kstStamp } from "@/lib/snapshot/clock";
import { useRowText } from "@/lib/snapshot/use-row-text";
import { useSnapshot } from "@/lib/snapshot/use-snapshot";
import {
  deriveBeachView,
  type BeachView,
  type ViewSource,
} from "@/lib/snapshot/view";
import { clearCheckedAt } from "@/lib/status-count";
import { useOnline } from "@/lib/use-online";

// 즐겨찾기 (BRD-35 · 노션 2장 FAV·D-FAV, Figma S_M05_01~03)
// [즐겨찾기 n | 최근 본] 전환 → 해변 행(상태 줄 포함, 묶지 않음). PC(lg)는 3열 카드
// 즐겨찾기·최근 본은 기기에만 저장(로그인 없음, D1). 노출 끈 해변은 목록에서 빼고 기기 기록은 지우지 않음(9장)
// 상태는 게시된 분류 그대로(G1). 지난 방문과 비교하는 변경 표시는 V2 출시에서 뺌(BRD-101)

type Tab = "favorites" | "recent";

type Item = { beach: BeachSummary; view: BeachView };

function toItems(
  ids: readonly string[],
  byId: ReadonlyMap<string, BeachSummary>,
  source: ViewSource,
): Item[] {
  return ids.flatMap((id) => {
    const beach = byId.get(id);
    return beach
      ? [{ beach, view: deriveBeachView({ id, hidden: false }, source) }]
      : [];
  });
}

export function FavoritesScreen({
  locale,
  beaches,
  sampleSnapshot,
}: {
  locale: Locale;
  beaches: BeachSummary[];
  sampleSnapshot: boolean; // 개발용 예시 특보·관측값을 보는 중. 배포 빌드는 늘 false
}) {
  const t = useTranslations();
  const params = useSearchParams();
  const snapshot = useSnapshot();
  const online = useOnline();
  const favoriteIds = useFavorites();
  const recentIds = useRecent();
  const { rowMeta, rowDetail } = useRowText();
  const toast = useToast();
  const titleRef = useRef<HTMLHeadingElement>(null);
  // 보는 칸은 주소(?tab=recent)를 따름: 홈 '최근 본 해변 · 전체 보기'로 들어오고, 탭 이동 뒤 돌아와도 그대로
  const tab: Tab = params.get("tab") === "recent" ? "recent" : "favorites";
  function setTab(next: Tab) {
    // 주소만 바꿈(기록 칸을 늘리지 않음). Next.js 라우터가 이 변경을 알아차림(검색 화면과 같은 방식)
    const path = window.location.pathname;
    window.history.replaceState(
      null,
      "",
      next === "recent" ? `${path}?tab=recent` : path,
    );
  }

  const byId = useMemo(
    () => new Map(beaches.map((beach) => [beach.id, beach])),
    [beaches],
  );
  // 저장 순서 그대로. 목록에 없는 id(노출 끈 해변)는 건너뜀(기기 기록은 지우지 않음)
  const favorites = useMemo(
    () => toItems(favoriteIds, byId, snapshot),
    [favoriteIds, byId, snapshot],
  );
  const recent = useMemo(
    () => toItems(recentIds, byId, snapshot),
    [recentIds, byId, snapshot],
  );
  const loading = snapshot.phase === "loading";

  // 확인된 판단 없음은 노출 중인 전체 해변으로 봄(탐색과 같은 규칙, BRD-38)
  const outage = useMemo(
    () =>
      sourceOutage(
        beaches.map((beach) =>
          deriveBeachView({ id: beach.id, hidden: false }, snapshot),
        ),
      ),
    [beaches, snapshot],
  );

  // 상황 배너는 하나만(탐색과 같은 범위: 오프라인 → 지원 밖 형식 → 불러오기 실패 → 출처 전체 장애). 관측 지연은 행 배지가 보여 줌
  const situation = pickSituation<Pick<BeachSummary, "name" | "slug">>({
    phase: snapshot.phase,
    live: snapshot.live,
    failedOnline: snapshot.failedOnline,
    online,
    delayed: [],
    locationOff: false,
    outage,
  });

  function removeOne(beach: BeachSummary) {
    const undo = removeRecent(beach.id);
    toast.show({
      text: t("favorites.recent.removed"),
      action: { label: t("favorites.recent.undo"), onClick: undo },
    });
  }

  function removeAll() {
    const undo = clearRecent();
    toast.show({
      text: t("favorites.recent.cleared"),
      action: { label: t("favorites.recent.undo"), onClick: undo },
    });
  }

  const items = tab === "favorites" ? favorites : recent;
  const nowMs = snapshot.nowMs;

  function renderRow({ beach, view }: Item) {
    if (view.kind !== "ready") return null;
    const common = {
      href: localizedPath(locale, `/spots/${beach.slug}/`),
      name: beach.name,
      meta: rowMeta(beach.region, null, view, nowMs),
      wave: view.metrics.waveHeight,
      status: view.badge,
      detail: rowDetail(view, nowMs),
    };
    return (
      <li
        key={beach.id}
        className="lg:grid lg:overflow-hidden lg:rounded-card lg:bg-bg-surface lg:shadow-card"
      >
        {tab === "recent" ? (
          <BeachRow
            {...common}
            onRemove={() => removeOne(beach)}
            removeLabel={t("favorites.recent.remove", { name: beach.name })}
          />
        ) : (
          <BeachRow {...common} />
        )}
      </li>
    );
  }

  // '특보 없음'이 보이는 목록이면 범위·기관·가장 이른 확인 시각 + 현장 우선 문구(늘)
  const readyViews = items.flatMap((item) =>
    item.view.kind === "ready" ? [item.view] : [],
  );
  const hasClear = readyViews.some(
    (view) => !view.stale && view.badge.kind === "clear",
  );
  const checkedAt = clearCheckedAt(readyViews);
  const clearTime = kstStamp(checkedAt, nowMs);

  const explore = (
    <Button asChild>
      <Link href={localizedPath(locale, "/explore/")}>
        {t("favorites.empty.action")}
      </Link>
    </Button>
  );

  return (
    <div className="flex flex-col gap-4">
      <h1
        ref={titleRef}
        tabIndex={-1}
        className="text-title-xl text-text-default outline-none"
      >
        {t("pages.favorites")}
      </h1>

      {sampleSnapshot && (
        <p
          role="note"
          className="rounded-card bg-bg-surface px-4 py-3 text-body-s text-text-body shadow-card"
        >
          {t("home.sampleSnapshot")}
        </p>
      )}

      <SituationBanner
        locale={locale}
        situation={situation?.kind === "noLocation" ? null : situation}
        snapshot={snapshot}
        onRetrySucceeded={() => titleRef.current?.focus()}
      />

      <ViewToggle<Tab>
        label={t("favorites.tabsLabel")}
        options={[
          {
            value: "favorites",
            label: t("favorites.tabFavorites", { count: favorites.length }),
          },
          { value: "recent", label: t("favorites.tabRecent") },
        ]}
        value={tab}
        onChange={setTab}
        className="lg:max-w-[360px]"
      />

      {tab === "recent" && recent.length > 0 && (
        <div className="-my-2 flex justify-end">
          <button
            type="button"
            onClick={removeAll}
            className="-mr-2 flex min-h-touch items-center px-2 text-body-s text-text-muted underline"
          >
            {t("favorites.recent.clear")}
          </button>
        </div>
      )}

      {items.length === 0 ? (
        tab === "favorites" ? (
          <EmptyState
            icon={<Star size={26} />}
            title={t("favorites.empty.title")}
            description={t("favorites.empty.body")}
            action={explore}
          />
        ) : (
          <EmptyState
            icon={<Clock size={26} />}
            title={t("favorites.recentEmpty.title")}
            description={t("favorites.recentEmpty.body")}
            action={explore}
          />
        )
      ) : loading ? (
        <BeachRowSkeleton
          rows={Math.min(items.length, 4)}
          label={t("favorites.loading")}
        />
      ) : (
        <div className="flex flex-col gap-2">
          <ul
            className={cn(
              "divide-y divide-border-default overflow-hidden rounded-card bg-bg-surface shadow-card",
              "lg:grid lg:grid-cols-3 lg:gap-4 lg:divide-y-0 lg:overflow-visible lg:rounded-none lg:bg-transparent lg:shadow-none",
            )}
          >
            {items.map(renderRow)}
          </ul>
          <div className="flex flex-col gap-0.5 text-caption text-text-muted">
            {hasClear && (
              <p>
                {clearTime
                  ? t("home.region.countScope", { time: clearTime })
                  : t("home.region.countScopeNoTime")}
              </p>
            )}
            <p>{t("safety.finalCall")}</p>
          </div>
        </div>
      )}

      <p className="text-caption text-text-muted">
        {t("favorites.deviceNote")}
      </p>

      <Toast message={toast.message} onHold={toast.hold} />
    </div>
  );
}

// 정적 HTML·주소 읽기 전 자리. 제목은 그대로 두고 목록 자리는 불러오는 모양
export function FavoritesFallback() {
  const t = useTranslations();
  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-title-xl text-text-default">
        {t("pages.favorites")}
      </h1>
      <BeachRowSkeleton label={t("favorites.loading")} />
    </div>
  );
}
