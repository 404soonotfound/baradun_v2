"use client"; // 검색어·지역·기기 저장·바다 정보를 쓰므로 브라우저 부품

import { SearchX } from "lucide-react";
import { useSearchParams } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { useMemo, useState, type FormEvent } from "react";

import { BackButton } from "@/components/detail/back-button";
import { RecentSearches } from "@/components/search/recent-searches";
import { SearchResultRow } from "@/components/search/search-result-row";
import { KmaSourceNote } from "@/components/source-note";
import { Button } from "@/components/ui/button";
import { Chip, RemovableChip } from "@/components/ui/chip";
import { EmptyState } from "@/components/ui/empty-state";
import { SearchField } from "@/components/ui/search-field";
import type { BeachSummary } from "@/lib/beach-summary";
import { filterBeaches } from "@/lib/explore";
import { localizedPath, type Locale } from "@/lib/i18n";
import { showsKmaSource } from "@/lib/kma-source";
import {
  clearRecentSearches,
  clipQuery,
  QUERY_MAX_LENGTH,
  removeRecentSearch,
  saveRecentSearch,
  useRecentSearches,
  visibleRecent,
} from "@/lib/recent-search";
import { useRegion } from "@/lib/region";
import {
  regionChips,
  regionGroups,
  regionName,
  validRegion,
} from "@/lib/region-list";
import { searchBeaches } from "@/lib/search";
import { useRowText } from "@/lib/snapshot/use-row-text";
import { useSnapshot } from "@/lib/snapshot/use-snapshot";
import { deriveBeachView } from "@/lib/snapshot/view";

// 검색 (BRD-31 · 노션 2장 SRCH, Figma L08·L09·S_M02_04)
// 뒤로 + 검색창(들어오면 바로 입력) → 입력 전: 최근 검색 + 지역으로 찾기 / 입력 중: 결과 / 결과 없음
// 검색어는 주소(?q=)에 둠(아키텍처 9.1). 검색은 브라우저에서 처리하고 서버로 보내지 않음
// 범위: 탐색에서 고른 지역을 따르고(칩으로 보임), 결과가 없으면 '전국에서 찾기'로 이 화면에서만 풀어 줌(저장 값은 안 바뀜)
// 활동으로는 거르지 않음(BRD-128 · 10/30 결정: 탐색과 같은 범위, 판단은 활동과 무관)

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
  const intlLocale = useLocale();
  const snapshot = useSnapshot();
  const recent = useRecentSearches();
  const { rowBasis } = useRowText();
  const tSearch = useTranslations("search");

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

  const region = validRegion(useRegion(), beaches);
  const groups = useMemo(() => regionGroups(beaches), [beaches]);
  const chips = useMemo(() => regionChips(beaches), [beaches]);

  // 검색 범위 칩: "강원 양양군". 전국이면 범위 칩 없음
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

  const pool = scoped ? filterBeaches(beaches, region) : beaches;
  const hits = searchBeaches(pool, query, intlLocale);
  const searching = query.trim() !== "";

  const visibleIds = useMemo(
    () => new Set(beaches.map((beach) => beach.id)),
    [beaches],
  );
  const recentItems = visibleRecent(recent, visibleIds);

  function submit(event: FormEvent) {
    event.preventDefault();
    if (searching) saveRecentSearch({ q: query, id: null });
  }

  const nowMs = snapshot.nowMs;
  // 행마다 상태를 한 번만 계산(안내 문구 여부와 행 표시에 같이 씀)
  const rows = hits.map((hit) => ({
    ...hit,
    view: deriveBeachView({ id: hit.beach.id, hidden: false }, snapshot),
  }));
  const hasClear = rows.some(
    ({ view }) =>
      view.kind === "ready" && !view.stale && view.badge.kind === "clear",
  );

  return (
    <div className="flex flex-col gap-4 lg:max-w-[448px]">
      <h1 className="sr-only">{t("pages.search")}</h1>
      <form
        role="search"
        onSubmit={submit}
        className="-ml-2 flex items-center gap-1"
      >
        <BackButton locale={locale} />
        <SearchField
          className="min-w-0 flex-1"
          label={t("home.top.search")}
          placeholder={t("nav.search")}
          value={query}
          maxLength={QUERY_MAX_LENGTH}
          // 들어오면 바로 입력(노션 SRCH '포커스, 키보드 자동')
          autoFocus
          enterKeyHint="search"
          onChange={(event) => update(event.target.value)}
        />
      </form>

      {/* 예시 값이 실제 확인 결과처럼 보이지 않게(홈·탐색과 같은 안내) */}
      {sampleSnapshot && (
        <p
          role="note"
          className="rounded-card bg-bg-surface px-4 py-3 text-body-s text-text-body shadow-card"
        >
          {t("home.sampleSnapshot")}
        </p>
      )}

      {scoped && (
        <div className="flex">
          <RemovableChip
            removeLabel={tSearch("scopeRemove", { scope: scopeLabel })}
            onRemove={() => setWidened(true)}
          >
            {scopeLabel}
          </RemovableChip>
        </div>
      )}

      {!searching ? (
        <>
          <RecentSearches
            items={recentItems}
            onPick={update}
            onRemove={removeRecentSearch}
            onClear={clearRecentSearches}
          />
          <section
            aria-labelledby="search-regions"
            className="flex flex-col gap-2"
          >
            <h2 id="search-regions" className="text-title-s text-text-default">
              {tSearch("byRegion")}
            </h2>
            <div className="flex flex-wrap gap-2">
              {chips.map((chip) => (
                <Chip
                  key={chip.key}
                  size="lg"
                  onClick={() => {
                    // 지역을 직접 골랐으니 탐색에서 고른 범위에 갇히지 않게 이 화면에서만 풂
                    setWidened(true);
                    update(chip.label);
                  }}
                >
                  {chip.label}
                </Chip>
              ))}
            </div>
          </section>
        </>
      ) : hits.length === 0 ? (
        <EmptyState
          icon={<SearchX size={26} />}
          title={
            scoped
              ? tSearch("empty.scoped", {
                  scope: scopeLabel,
                  query: query.trim(),
                })
              : tSearch("empty.all", { query: query.trim() })
          }
          description={tSearch("empty.body")}
          action={
            scoped ? (
              <Button variant="secondary" onClick={() => setWidened(true)}>
                {tSearch("empty.widen")}
              </Button>
            ) : undefined
          }
        />
      ) : (
        <section className="flex flex-col gap-2">
          <p role="status" className="text-caption text-text-muted">
            {tSearch("count", { count: hits.length })}
          </p>
          <ul className="divide-y divide-border-default overflow-hidden rounded-card bg-bg-surface shadow-card">
            {rows.map(({ beach, match, view }) => (
              <SearchResultRow
                key={beach.id}
                href={localizedPath(locale, `/spots/${beach.slug}/`)}
                name={beach.name}
                region={beach.region}
                query={query}
                match={match}
                view={view}
                basis={rowBasis(view, nowMs)}
                onOpen={() => saveRecentSearch({ q: query, id: beach.id })}
              />
            ))}
          </ul>
          {hasClear && (
            <p className="text-caption text-text-muted">
              {t("safety.finalCall")}
            </p>
          )}
          {/* 결과 줄의 배지·파고가 기상청 자료(BRD-113 · 기상법). 받은 실제 상태가 있을 때만(개발용 예시 제외) */}
          {showsKmaSource(snapshot, sampleSnapshot) && (
            <KmaSourceNote variant="status" />
          )}
        </section>
      )}
    </div>
  );
}

// 주소를 읽기 전(정적 HTML)에 보이는 자리 표시: 화면 읽기 프로그램에는 화면 이름을 알리고, 검색창 모양만 그림
export function SearchFallback() {
  const t = useTranslations("pages");
  return (
    <div className="flex flex-col gap-4 lg:max-w-[448px]">
      <h1 className="sr-only">{t("search")}</h1>
      <div
        aria-hidden="true"
        className="h-search rounded-input border border-border-strong bg-bg-surface"
      />
    </div>
  );
}
