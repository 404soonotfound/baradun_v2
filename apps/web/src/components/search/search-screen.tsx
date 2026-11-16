"use client"; // 검색어·지역·기기 저장·바다 정보를 쓰므로 브라우저 부품

import { Search, SearchX, X } from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from "react";

import { RegionSheet } from "@/components/region/region-sheet";
import { SampleNote } from "@/components/sample-note";
import { RecentSearches } from "@/components/search/recent-searches";
import { SearchResultRow } from "@/components/search/search-result-row";
import {
  optionId,
  SearchSuggestions,
  type SuggestOption,
} from "@/components/search/search-suggestions";
import { KmaSourceNote } from "@/components/source-note";
import { Button } from "@/components/ui/button";
import { Chip, RemovableChip } from "@/components/ui/chip";
import { SCREEN_TITLE_CLASS } from "@/components/ui/screen-title";
import { SearchField } from "@/components/ui/search-field";
import { ViewToggle } from "@/components/ui/view-toggle";
import type { BeachSummary } from "@/lib/beach-summary";
import { cn } from "@/lib/cn";
import { queryLengthBucket, trackEvent } from "@/lib/analytics/events";
import {
  asksLocationOnNear,
  buildItems,
  filterBeaches,
  sortItems,
  type ExploreItem,
} from "@/lib/explore";
import { useRecent } from "@/lib/favorites";
import { localizedPath, type Locale } from "@/lib/i18n";
import { showsKmaSource } from "@/lib/kma-source";
import { requestLocation, useUserLocation } from "@/lib/location";
import { formatKm, joinMeta } from "@/lib/meta-join";
import { photoSourceUrl } from "@/lib/photo-credit";
import {
  clearRecentSearches,
  clipQuery,
  QUERY_MAX_LENGTH,
  removeRecentSearch,
  saveRecentSearch,
  useRecentSearches,
  visibleRecent,
} from "@/lib/recent-search";
import { setRegion, useRegion } from "@/lib/region";
import {
  NATIONWIDE,
  regionChips,
  regionGroups,
  regionName,
  validRegion,
} from "@/lib/region-list";
import { matchRegions, searchBeaches, withParticle } from "@/lib/search";
import { kstStamp } from "@/lib/snapshot/clock";
import { useBadgeText } from "@/lib/snapshot/use-badge-text";
import { useMetaText } from "@/lib/snapshot/use-meta-text";
import { useRowText } from "@/lib/snapshot/use-row-text";
import { useSnapshot } from "@/lib/snapshot/use-snapshot";
import { deriveBeachView } from "@/lib/snapshot/view";
import { shownDataTime } from "@/lib/situation";
import { clearCheckedAt, staleCheckedAt } from "@/lib/status-count";
import { useSheet } from "@/lib/use-sheet";
import { beachZonesText, zoneNameText } from "@/lib/zone-name";
import { ZONE_NAMES_KO } from "@/lib/zone-names-ko";

// 검색 v5 (BRD-31 · GH-531 · 결정 기록 29장 D29-5·D29-6·D29-7, 노션 2장 SRCH, 시안 S_SRC0P2·S_SRCQ·S_SRCR·S_SRCN)
// 즐겨찾기·설정과 같은 1036px 본문. 머리: 제목 '검색' + 오른쪽 '찾는 범위' → 본문 폭 검색 칸(뒤로 버튼 없음)
// 입력 전: 최근 검색 → 최근 본 해변 → 지역으로 찾기 → 안내 / 입력 중: 검색 칸 아래 제안(콤보박스) / 결과 / 결과 없음
// 검색어는 주소(?q=)에 둠(아키텍처 9.1). 검색은 브라우저에서 처리하고 서버로 보내지 않음. 별칭 검색·최근 검색 저장 규칙은 그대로
// 범위: 탐색에서 고른 지역을 따르고(칩), '전국에서 찾기'는 이 화면에서만 풂(저장 값은 안 바뀜)
// '범위 정하기'·'범위를 ○○으로'는 홈·탐색과 같은 저장 지역을 바꿈(같은 지역 시트)
// 활동으로는 거르지 않음(D14-15). 상태·개수는 게시값 그대로(G1), 결측·지연을 정상으로 보이지 않음(listMeta·listNote)

const SUGGEST_BEACHES = 4; // 제안의 해변 줄 수(D29-7)
const RESULT_PAGE = 8; // 결과 첫 화면 줄 수. 나머지는 'n곳 더 보기'로 한 번에
const RECENT_VIEWED = 4; // 입력 전 최근 본 해변 줄 수(시안 S_SRC0P2)

type SortChoice = "near" | "name";
type FilterChoice = "all" | "observed";

export function SearchScreen({
  locale,
  beaches,
  sampleSnapshot,
}: {
  locale: Locale;
  beaches: BeachSummary[];
  sampleSnapshot: boolean; // 개발용 예시 특보·관측값을 보는 중. 배포 빌드는 늘 false
}) {
  const t = useTranslations();
  const tSearch = useTranslations("search");
  const intlLocale = useLocale();
  const router = useRouter();
  const snapshot = useSnapshot();
  const recent = useRecentSearches();
  const recentViewed = useRecent();
  const location = useUserLocation();
  const { confirmedUntilText } = useBadgeText();
  const { agencyText } = useMetaText();
  const { listMeta, listNote, activitiesText, zoneLine } = useRowText();
  const regionSheet = useSheet("region");
  const listId = useId();
  const inputRef = useRef<HTMLInputElement>(null);

  // 검색어는 주소(?q=)가 기준. 입력하는 동안은 입력 중인 값(typed)을 쓰고, 주소가 '내가 쓴 값'이 아닌 것으로
  // 바뀌면(상단 검색 링크·뒤로/앞으로) 입력 상태를 버리고 주소를 따라감
  const urlQuery = clipQuery(useSearchParams().get("q") ?? "");
  const [typed, setTyped] = useState<string | null>(null);
  const [written, setWritten] = useState<readonly string[]>([]); // 이 화면이 주소에 쓴 값들
  const [seenUrl, setSeenUrl] = useState(urlQuery);
  if (urlQuery !== seenUrl) {
    // 그리는 중 상태 맞추기 패턴(SituationBanner와 같음)
    setSeenUrl(urlQuery);
    const index = written.indexOf(urlQuery);
    if (index === -1) {
      setTyped(null);
      setWritten([]);
    } else {
      // 알아본 값까지는 소비함: 오래 남은 값("" 등)이 뒤의 바깥 이동을 '내가 쓴 값'으로 오인하지 않게
      setWritten(written.slice(index + 1));
    }
  }
  const query = typed ?? urlQuery;
  const [widened, setWidened] = useState(false); // '전국에서 찾기'(이 화면에서만)
  const [suggestOpen, setSuggestOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [sort, setSort] = useState<SortChoice>("near");
  const [filter, setFilter] = useState<FilterChoice>("all");
  // 'n곳 더 보기'를 누른 결과(검색어·정렬·거르기·범위가 바뀌면 다시 첫 화면만)
  const [expandedFor, setExpandedFor] = useState<string | null>(null);

  const region = validRegion(useRegion(), beaches);
  const groups = useMemo(() => regionGroups(beaches), [beaches]);
  const chips = useMemo(() => regionChips(beaches), [beaches]);
  // 지역 칩 옆 해변 수(시·도별). 입력할 때마다 다시 세지 않게 한 번만
  const chipCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const beach of beaches) {
      counts.set(beach.sido.key, (counts.get(beach.sido.key) ?? 0) + 1);
    }
    return counts;
  }, [beaches]);

  // 찾는 범위: 탐색에서 고른 지역 "강원 강릉시". 전국이면 범위 없음
  const scopeLabel = region === null ? null : regionName(groups, region);
  const scoped = scopeLabel !== null && !widened;

  function update(next: string) {
    const value = clipQuery(next);
    setTyped(value);
    setWritten((list) => [
      ...list.slice(-19),
      value.trim() === "" ? "" : value,
    ]);
    // 주소만 바꿈(기록 칸을 늘리지 않음). Next.js 라우터가 이 변경을 알아차림
    const path = window.location.pathname;
    const url =
      value.trim() === "" ? path : `${path}?q=${encodeURIComponent(value)}`;
    window.history.replaceState(null, "", url);
  }

  // 사용자가 입력할 때만 제안을 엶(최근 검색·지역 칩·주소로 들어온 검색어는 바로 결과)
  function type(next: string) {
    update(next);
    setSuggestOpen(clipQuery(next).trim() !== "");
    setActive(-1);
  }
  function closeSuggest() {
    setSuggestOpen(false);
    setActive(-1);
  }

  const coords = location.status === "ready" ? location.coords : null;
  const searching = query.trim() !== "";
  const pool = scoped ? filterBeaches(beaches, region) : beaches;
  const hits = searchBeaches(pool, query, intlLocale);
  const matchById = new Map(hits.map((hit) => [hit.beach.id, hit.match]));
  // 해변 → 줄(거리 · 게시된 상태 그대로, 측정소 없는 값은 숨김: buildItems). 찾은 순서는 그대로 둠
  const items = buildItems(
    hits.map((hit) => hit.beach),
    coords,
    (beach) => deriveBeachView({ id: beach.id, hidden: false }, snapshot),
  );
  const regionHits = matchRegions(pool, query, intlLocale);

  // 범위 때문에 빠진 해변 수(결과 없음 '범위를 풀면 n곳이 맞아요')와 범위를 옮길 지역
  // 결과 없음 화면에서만 씀(결과가 있을 때 전체 해변을 한 번 더 찾지 않게)
  const widens = scoped && searching && hits.length === 0;
  const wideHits = widens ? searchBeaches(beaches, query, intlLocale) : hits;
  // 맞는 시·군이 하나일 때만 범위를 옮김(시·도처럼 여러 시·군에 걸치면 하나로 좁히지 않음)
  const wideRegions = widens ? matchRegions(beaches, query, intlLocale) : [];
  const wideRegion = wideRegions.length === 1 ? wideRegions[0] : undefined;

  const lastNoResultKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (!searching || hits.length > 0) {
      lastNoResultKeyRef.current = null;
      return;
    }
    const bucket = queryLengthBucket(query);
    const key = `${locale}:${scoped}:${bucket}`;
    if (lastNoResultKeyRef.current === key) return;
    lastNoResultKeyRef.current = key;
    trackEvent("search_no_result", {
      locale,
      query_length_bucket: bucket,
    });
  }, [hits.length, locale, query, scoped, searching]);

  const visibleIds = useMemo(
    () => new Set(beaches.map((beach) => beach.id)),
    [beaches],
  );
  const recentItems = visibleRecent(recent, visibleIds);
  const nowMs = snapshot.nowMs;
  const dataTime = shownDataTime(snapshot.manifest?.generatedAt, nowMs);

  // 정렬: 가까운 순은 위치가 있을 때 거리순, 없으면 찾은 순(자동으로 묻지 않음, 누르면 그때 물음 D14-17). 이름 순은 이름
  const nearItems = coords ? sortItems(items, "near", intlLocale) : items;
  const sorted =
    sort === "name"
      ? sortItems(items, "name", intlLocale)
      : coords
        ? sortItems(items, "near", intlLocale)
        : items;
  // 거르기 '가까운 관측 있음' = 2줄째 수온이 '가까운 관측 없음'이 아닌 해변(같은 측정소 기준이라 줄과 어긋나지 않음)
  // 게시값 기준(받기 전에는 측정소 자료): 2줄째가 '가까운 관측 없음'이면 빠짐
  const observed = sorted.filter((item) =>
    item.view.kind === "ready"
      ? item.view.metrics.waterTemp.kind !== "none"
      : item.stations.waterTemp !== null,
  );
  const filtered = filter === "observed" ? observed : sorted;
  const pageKey = `${query}|${sort}|${filter}|${scoped ? scopeLabel : ""}`;
  const expanded = expandedFor === pageKey;
  const shown = expanded ? filtered : filtered.slice(0, RESULT_PAGE);

  function pickSort(next: SortChoice) {
    setSort(next);
    if (next === "near" && asksLocationOnNear(location.status)) {
      requestLocation();
    }
  }

  // 해변들의 바다 특보구역 이름('강원북부앞바다'). 해변마다 다르거나 이름을 모르면 일반 이름('해변 특보구역')
  function seaZoneText(list: readonly Pick<BeachSummary, "warningZones">[]) {
    const codes = new Set(list.map((item) => item.warningZones.sea));
    const [code] = [...codes];
    const name = code === undefined ? undefined : ZONE_NAMES_KO[code];
    if (codes.size !== 1 || code === undefined || name === undefined) {
      return t("warning.beachZones");
    }
    const zone = zoneNameText({ zoneCode: code, zoneName: name }, locale);
    return zone.untranslated ? t("warning.beachZones") : zone.text;
  }

  // 특보 없음 근거의 범위: 해변 특보구역 이름(바다·육상, D18-11 · 줄의 zonesText와 같은 규칙)
  // 해변마다 다르거나 이름을 모르면 일반 이름('해변 특보구역')
  function clearZonesText(
    list: readonly Pick<BeachSummary, "warningZones">[],
  ): string {
    const names = new Set(
      list.map((item) => beachZonesText(item.warningZones, locale)),
    );
    const [name] = [...names];
    return names.size === 1 && name ? name : t("warning.beachZones");
  }

  // 결과 머리 아래 특보 한 줄: '특보 없음 n곳 · 구역 · 기상청 HH:MM 확인 · 거리는 내 위치 기준'
  // 특보 없음이 없으면 범위 줄 없음(칩이 사유를 보여 줌). 오래된 정보는 'HH:MM 확인 · 이후 확인 못 함'
  function scopeLine(
    list: readonly ExploreItem[],
    { distance = true }: { distance?: boolean } = {},
  ): string | null {
    const ready = list.flatMap((item) =>
      item.view.kind === "ready" ? [item.view] : [],
    );
    const clearItems = list.filter(
      (item) =>
        item.view.kind === "ready" &&
        !item.view.stale &&
        item.view.badge.kind === "clear",
    );
    const stale = staleCheckedAt(ready);
    const time = kstStamp(clearCheckedAt(ready), nowMs);
    const zone = clearZonesText(clearItems);
    const clear =
      clearItems.length === 0
        ? null
        : time
          ? tSearch("results.clearLine", {
              count: clearItems.length,
              zone,
              time,
            })
          : tSearch("results.clearLineNoTime", {
              count: clearItems.length,
              zone,
            });
    return joinMeta([
      clear,
      stale ? confirmedUntilText(stale.confirmedAt, nowMs) : null,
      distance && coords ? t("explore.distanceFromMe") : null,
    ]);
  }

  // --- 입력 중 제안 ---
  const options: SuggestOption[] = [
    ...regionHits.slice(0, 2).map((match) => ({
      kind: "region" as const,
      region: {
        key: match.key,
        label: match.label,
        detail: tSearch("suggest.regionLine", {
          count: match.beaches.length,
          zones: seaZoneText(match.beaches),
        }),
      },
    })),
    ...nearItems.slice(0, SUGGEST_BEACHES).map((item) => ({
      kind: "beach" as const,
      beach: {
        id: item.id,
        name: item.name,
        photo: item.photo,
        region: item.region,
        meta:
          joinMeta([
            item.region,
            item.distanceKm === null ? null : `${formatKm(item.distanceKm)}km`,
          ]) ?? item.region,
        view: item.view,
      },
    })),
    ...(hits.length > 0 ? [{ kind: "all" as const }] : []),
  ];
  const listOpen = suggestOpen && searching && options.length > 0;
  // 줄 수가 줄어들면(다른 탭에서 범위가 바뀌는 등) 없는 줄을 가리키지 않게
  const activeIndex = active < options.length ? active : -1;
  // 제안의 해변 줄에 '특보 없음' 칩이 있으면 범위·기관·확인 시각을 제안 안에 한 번(뒤 결과 머리는 흐려져 있음). 열렸을 때만 만듦
  const suggestClearNote = listOpen
    ? scopeLine(nearItems.slice(0, SUGGEST_BEACHES), { distance: false })
    : null;

  function pick(option: SuggestOption) {
    if (option.kind === "region") {
      // 지역 결과: 그 지역 이름으로 다시 찾음(지역 이름에 맞는 해변 = 그 시·군 해변)
      // 지역 칩과 같게 최근 검색에 저장하지 않고 분석 이벤트도 남기지 않음(저장 규칙은 지금 그대로: 제출·해변 고름만)
      update(option.region.label);
    } else if (option.kind === "beach") {
      const item = items.find((entry) => entry.id === option.beach.id);
      if (item) {
        saveRecentSearch({ q: query, id: item.id });
        trackEvent("select_search_result", { result_kind: "beach", locale });
        router.push(localizedPath(locale, `/spots/${item.slug}/`));
      }
    } else {
      saveRecentSearch({ q: query, id: null });
    }
    closeSuggest();
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    // 한글 조합 중 Enter·화살표는 조합을 끝내는 키라 줄 고르기·이동으로 쓰지 않음(두 번 움직이거나 조합 중 열리지 않게)
    // Safari는 조합을 끝내는 keydown에 isComposing=false · keyCode 229를 줌
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (event.key === "Escape") {
      if (listOpen) {
        event.preventDefault();
        closeSuggest();
      }
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      if (!searching || options.length === 0) return;
      event.preventDefault();
      setSuggestOpen(true);
      const step = event.key === "ArrowDown" ? 1 : -1;
      setActive((current) =>
        current === -1 && step === -1
          ? options.length - 1
          : (current + step + options.length) % options.length,
      );
      return;
    }
    if (event.key === "Enter" && listOpen && activeIndex >= 0) {
      event.preventDefault();
      pick(options[activeIndex]!);
    }
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    if (searching) saveRecentSearch({ q: query, id: null });
    closeSuggest();
  }

  // --- 입력 전: 최근 본 해변(기기에 저장된 최근 본 순, 공개 해변만) ---
  const viewedItems = useMemo(() => {
    const byId = new Map(beaches.map((beach) => [beach.id, beach]));
    const picked = recentViewed
      .map((id) => byId.get(id))
      .filter((beach): beach is BeachSummary => beach !== undefined)
      .slice(0, RECENT_VIEWED);
    return buildItems(picked, coords, (beach) =>
      deriveBeachView({ id: beach.id, hidden: false }, snapshot),
    );
  }, [beaches, recentViewed, coords, snapshot]);

  // 화면 아래 사진 출처: 지금 보이는 줄의 사진 출처를 기관마다 한 번씩(지어내지 않음). 사진이 없으면 줄 없음
  const shownPhotos = [
    ...new Map(
      (searching ? shown : viewedItems)
        .flatMap((item) => (item.photo ? [item.photo] : []))
        .map((photo) => [photo.source, photo]),
    ).values(),
  ];
  const kmaSource = showsKmaSource(snapshot, sampleSnapshot);

  function regionChipList() {
    return (
      <section aria-labelledby="search-regions" className="flex flex-col gap-3">
        <div className="flex items-baseline justify-between gap-2">
          <h2 id="search-regions" className="text-title-m text-text-default">
            {tSearch("byRegion")}
          </h2>
          <span className="text-caption text-text-muted">
            {tSearch("byRegionNote", { count: beaches.length })}
          </span>
        </div>
        <div className="flex flex-wrap gap-2">
          {chips.map((chip) => {
            const count = chipCounts.get(chip.key) ?? 0;
            return (
              <Chip
                key={chip.key}
                size="lg"
                aria-label={tSearch("regionChip", {
                  region: chip.label,
                  count,
                })}
                onClick={() => {
                  // 지역을 직접 골랐으니 탐색에서 고른 범위에 갇히지 않게 이 화면에서만 풂
                  setWidened(true);
                  update(chip.label);
                  closeSuggest();
                }}
              >
                {chip.label}
                <span className="text-text-muted">{count}</span>
              </Chip>
            );
          })}
        </div>
      </section>
    );
  }

  // 화면 아래 안내(D29-5): 특보 없음은 안전 보장 아님 · 현장 우선 · 사진 출처(사진을 보일 때) · 이 기기에만 저장
  function footNotes(withStorage: boolean) {
    return (
      <div className="flex flex-col gap-1 text-caption text-text-muted">
        <p>{tSearch("notes.safety")}</p>
        {shownPhotos.map((photo) => {
          const href = photoSourceUrl(photo);
          return (
            <p key={photo.source}>
              {tSearch.rich("notes.photo", {
                source: agencyText(photo.source),
                link: (chunks) =>
                  href ? (
                    <a
                      href={href}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="underline underline-offset-2"
                    >
                      {chunks}
                      <span className="sr-only">
                        {" "}
                        ({t("common.newWindow")})
                      </span>
                    </a>
                  ) : (
                    chunks
                  ),
              })}
            </p>
          );
        })}
        {withStorage && <p>{tSearch("notes.storage")}</p>}
        {kmaSource && <KmaSourceNote variant="status" />}
      </div>
    );
  }

  // '지역 ○○과 맞음'은 맞는 시·군이 하나일 때만(시·도 검색에 한 시·군 이름을 대지 않음)
  const regionMatch = regionHits.length === 1 ? regionHits[0] : undefined;
  const scopeTo =
    scopeLabel === null
      ? ""
      : locale === "ko"
        ? withParticle(scopeLabel, "direction")
        : scopeLabel;
  const resultLine = scopeLine(filtered);

  return (
    <div className="flex flex-col gap-6 pt-4 lg:mx-auto lg:w-full lg:max-w-[1036px] lg:pt-0">
      {/* 머리(D29-6): 제목 + 오른쪽 찾는 범위 */}
      <div className="flex flex-col gap-4">
        <div className="flex items-center justify-between gap-3">
          <h1 className={SCREEN_TITLE_CLASS}>{t("pages.search")}</h1>
          <div className="flex shrink-0 items-center gap-2">
            <span className="text-caption text-text-muted">
              {tSearch("scope.label")}
            </span>
            {scoped ? (
              <RemovableChip
                removeLabel={tSearch("scopeRemove", { scope: scopeLabel })}
                onRemove={() => setWidened(true)}
              >
                {scopeLabel}
              </RemovableChip>
            ) : (
              <>
                <span className="flex h-chip items-center rounded-full border border-border-strong bg-bg-surface px-[13px] text-[12.5px] text-text-body">
                  {tSearch("scope.nationwide")}
                </span>
                <button
                  type="button"
                  aria-haspopup="dialog"
                  onClick={regionSheet.show}
                  className="-mx-1 flex min-h-touch items-center px-1 text-caption font-bold text-brand-default hover:underline"
                >
                  {tSearch("scope.pick")}
                </button>
              </>
            )}
          </div>
        </div>

        {/* 검색 칸(본문 폭) + 입력 중 제안. 바깥으로 포커스가 나가면 제안을 닫음 */}
        <form
          role="search"
          onSubmit={submit}
          className="relative"
          onBlur={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget as Node))
              closeSuggest();
          }}
        >
          <SearchField
            ref={inputRef}
            label={t("home.top.search")}
            placeholder={tSearch("placeholder")}
            value={query}
            maxLength={QUERY_MAX_LENGTH}
            // 들어오면 바로 입력(노션 SRCH '포커스, 키보드 자동')
            autoFocus
            enterKeyHint="search"
            role="combobox"
            aria-autocomplete="list"
            aria-expanded={listOpen}
            aria-controls={listOpen ? listId : undefined}
            aria-activedescendant={
              listOpen && activeIndex >= 0
                ? optionId(listId, activeIndex)
                : undefined
            }
            onChange={(event) => type(event.target.value)}
            onKeyDown={onKeyDown}
            trailing={
              query !== "" && (
                <button
                  type="button"
                  aria-label={tSearch("clearQuery")}
                  onClick={() => {
                    update("");
                    closeSuggest();
                    inputRef.current?.focus();
                  }}
                  className="-mr-2 flex size-touch shrink-0 items-center justify-center rounded-full text-text-default hover:bg-bg-subtle"
                >
                  <X aria-hidden="true" size={16} strokeWidth={2.5} />
                </button>
              )
            }
          />
          {listOpen && (
            <SearchSuggestions
              id={listId}
              query={query}
              options={options}
              total={hits.length}
              located={coords !== null}
              clearNote={suggestClearNote}
              active={activeIndex}
              onPick={pick}
              onHover={setActive}
            />
          )}
        </form>
      </div>

      {/* 결과 수 알림. 제안이 열리면 뒤 내용이 inert라 그 안의 알림은 읽히지 않으므로 바깥에 둠 */}
      <p role="status" className="sr-only">
        {searching && hits.length > 0
          ? tSearch("results.title", {
              query: query.trim(),
              count: hits.length,
            })
          : ""}
      </p>

      {/* 예시 값이 실제 확인 결과처럼 보이지 않게(홈·탐색과 같은 안내) */}
      {sampleSnapshot && <SampleNote />}

      {/* 제안이 열린 동안 뒤 내용은 흐리게 하고 Tab으로 닿지 않게(검색 칸 · 제안에 집중) */}
      <div
        inert={listOpen}
        className={cn(
          "flex flex-col gap-7 transition-opacity motion-reduce:transition-none",
          listOpen && "opacity-40",
        )}
      >
        {!searching ? (
          <>
            <RecentSearches
              items={recentItems}
              onPick={(q) => {
                update(q);
                closeSuggest();
              }}
              onRemove={removeRecentSearch}
              onClear={clearRecentSearches}
            />
            {viewedItems.length > 0 && (
              <section
                aria-labelledby="search-viewed"
                className="flex flex-col gap-3"
              >
                <div className="flex items-baseline justify-between gap-2">
                  <h2
                    id="search-viewed"
                    className="text-title-m text-text-default"
                  >
                    {tSearch("viewed.title")}
                  </h2>
                  {dataTime && (
                    <span className="text-caption text-text-muted">
                      {t("explore.summary.updated", { time: dataTime })}
                    </span>
                  )}
                </div>
                <ul className="divide-y divide-border-default overflow-hidden rounded-card bg-bg-surface shadow-card">
                  {viewedItems.map((item) => {
                    const view = item.view;
                    // 구역 줄이 특보 없음·특보 발효의 근거를 말함. 그 밖(오래된 정보 포함)은 구역 줄이 곧 사유(listNote)라 넷째 줄 없음
                    const zoneShown =
                      view.kind === "ready" &&
                      !view.stale &&
                      (view.badge.kind === "clear" ||
                        view.badge.kind === "warning");
                    return (
                      <SearchResultRow
                        key={item.id}
                        href={localizedPath(locale, `/spots/${item.slug}/`)}
                        name={item.name}
                        photo={item.photo}
                        region={item.region}
                        query=""
                        match={null}
                        view={view}
                        meta={listMeta(
                          item.region,
                          item.distanceKm,
                          view,
                          nowMs,
                        )}
                        detail={zoneLine(view, nowMs, item.warningZones)}
                        note={zoneShown ? listNote(view, nowMs) : null}
                      />
                    );
                  })}
                </ul>
              </section>
            )}
            {regionChipList()}
            {footNotes(true)}
          </>
        ) : hits.length === 0 ? (
          <>
            <section
              aria-labelledby="search-empty"
              className="flex flex-col items-center gap-3 rounded-card bg-bg-surface px-5 py-8 text-center shadow-card"
            >
              <span
                aria-hidden="true"
                className="flex size-14 items-center justify-center rounded-full bg-bg-subtle text-text-muted"
              >
                <SearchX size={24} />
              </span>
              {/* 무슨 일 → 영향 → 다음 행동. 범위 때문이면 범위를 풀었을 때 맞는 수를 알림(D29-7) */}
              {/* 상태 알림은 제목을 감싼 칸에(제목에 role="status"를 붙이면 제목이 아니게 됨) */}
              <div role="status">
                <h2
                  id="search-empty"
                  className="text-title-s text-text-default"
                >
                  {scoped
                    ? tSearch("empty.scopedTitle", {
                        scope: scopeLabel,
                        query: query.trim(),
                      })
                    : tSearch("empty.allTitle", { query: query.trim() })}
                </h2>
              </div>
              <p className="text-body-s text-text-body">
                {scoped && wideHits.length > 0
                  ? tSearch("empty.scopedBody", {
                      scopeTo,
                      count: wideHits.length,
                    })
                  : scoped
                    ? tSearch("empty.scopedNoneBody", { scopeTo })
                    : tSearch("empty.allBody")}
              </p>
              {scoped && (
                <div className="mt-1 flex flex-wrap justify-center gap-2">
                  <Button onClick={() => setWidened(true)}>
                    {tSearch("empty.widen")}
                  </Button>
                  {wideRegion && wideHits.length > 0 && (
                    <Button
                      variant="secondary"
                      onClick={() => {
                        const beach = wideRegion.beaches[0]!;
                        // 찾는 범위 = 홈·탐색이 함께 쓰는 지역(저장). 범위를 옮기면 그 지역 결과가 보임
                        setRegion({
                          sido: beach.sido.key,
                          sigungu: beach.sigungu.key,
                        });
                        setWidened(false);
                      }}
                    >
                      {tSearch("empty.narrowTo", {
                        region:
                          locale === "ko"
                            ? withParticle(wideRegion.label, "direction")
                            : wideRegion.label,
                      })}
                    </Button>
                  )}
                </div>
              )}
            </section>
            {regionChipList()}
            <p className="text-body-s text-text-body">
              {tSearch.rich("empty.inquiry", {
                link: (chunks) => (
                  <Link
                    href={localizedPath(locale, "/settings/inquiry/")}
                    className="font-bold text-brand-default underline underline-offset-2"
                  >
                    {chunks}
                  </Link>
                ),
              })}
            </p>
          </>
        ) : (
          <section
            aria-labelledby="search-results"
            className="flex flex-col gap-3"
          >
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2 id="search-results" className="text-body text-text-default">
                  <span className="font-bold">
                    {tSearch("results.title", {
                      query: query.trim(),
                      count: hits.length,
                    })}
                  </span>
                  {regionMatch && (
                    <span className="text-caption text-text-muted">
                      {" · "}
                      {tSearch("results.regionMatch", {
                        region:
                          locale === "ko"
                            ? withParticle(regionMatch.label, "with")
                            : regionMatch.label,
                      })}
                    </span>
                  )}
                </h2>
              </div>
              <ViewToggle<SortChoice>
                label={tSearch("sort.label")}
                className="w-[200px] shrink-0"
                options={[
                  { value: "near", label: tSearch("sort.near") },
                  { value: "name", label: tSearch("sort.name") },
                ]}
                value={sort}
                onChange={pickSort}
              />
            </div>
            {/* 거르기: 활동으로는 거르지 않음(D14-15). 고른 칩은 눌림 상태로 알림 */}
            <div
              role="group"
              aria-label={tSearch("filter.label")}
              className="flex flex-wrap gap-2"
            >
              {(
                [
                  ["all", tSearch("filter.all", { count: sorted.length })],
                  [
                    "observed",
                    tSearch("filter.observed", { count: observed.length }),
                  ],
                ] as const
              ).map(([value, label]) => (
                <Chip
                  key={value}
                  size="lg"
                  aria-pressed={filter === value}
                  className={cn(
                    filter === value &&
                      "border-brand-default bg-brand-weak font-bold text-brand-default",
                  )}
                  onClick={() => setFilter(value)}
                >
                  {label}
                </Chip>
              ))}
            </div>
            {resultLine && (
              <p className="text-caption text-text-muted">{resultLine}</p>
            )}
            {filtered.length === 0 ? (
              <p className="rounded-card bg-bg-surface px-5 py-6 text-center text-body-s text-text-body shadow-card">
                {tSearch("filter.none")}
              </p>
            ) : (
              <ul className="divide-y divide-border-default overflow-hidden rounded-card bg-bg-surface shadow-card">
                {shown.map((item) => (
                  <SearchResultRow
                    key={item.id}
                    href={localizedPath(locale, `/spots/${item.slug}/`)}
                    name={item.name}
                    photo={item.photo}
                    region={item.region}
                    query={query}
                    match={matchById.get(item.id) ?? null}
                    view={item.view}
                    meta={listMeta(
                      item.region,
                      item.distanceKm,
                      item.view,
                      nowMs,
                    )}
                    detail={activitiesText(item.activities)}
                    note={listNote(item.view, nowMs)}
                    onOpen={() => {
                      saveRecentSearch({ q: query, id: item.id });
                      trackEvent("select_search_result", {
                        result_kind: "beach",
                        locale,
                      });
                    }}
                  />
                ))}
              </ul>
            )}
            {!expanded && filtered.length > RESULT_PAGE && (
              <div className="flex justify-center">
                <Button
                  variant="secondary"
                  onClick={() => setExpandedFor(pageKey)}
                >
                  {tSearch("results.more", {
                    count: filtered.length - RESULT_PAGE,
                  })}
                </Button>
              </div>
            )}
            {footNotes(false)}
          </section>
        )}
      </div>

      {/* 범위 정하기: 홈·탐색과 같은 지역 시트(같은 저장 값). 고르면 그 범위로 다시 찾음 */}
      <RegionSheet
        open={regionSheet.open}
        onClose={regionSheet.close}
        groups={groups}
        value={region}
        onSelect={(next) => {
          setRegion(next);
          setWidened(false);
          regionSheet.close();
        }}
        nationwide={{
          selected: region === null,
          onSelect: () => {
            setRegion(NATIONWIDE);
            setWidened(false);
            regionSheet.close();
          },
        }}
      />
    </div>
  );
}

// 주소를 읽기 전(정적 HTML)에 보이는 자리 표시: 화면 읽기 프로그램에는 화면 이름을 알리고, 머리·검색 칸 모양만 그림
export function SearchFallback() {
  const t = useTranslations("pages");
  return (
    <div className="flex flex-col gap-4 pt-4 lg:mx-auto lg:w-full lg:max-w-[1036px] lg:pt-0">
      <h1 className={SCREEN_TITLE_CLASS}>{t("search")}</h1>
      <div
        aria-hidden="true"
        className="flex h-search items-center gap-2.5 rounded-input border border-border-strong bg-bg-surface px-[15px] text-text-muted"
      >
        <Search size={17} />
      </div>
    </div>
  );
}
