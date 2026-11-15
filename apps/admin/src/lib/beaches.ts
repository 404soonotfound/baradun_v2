import type { Reason, WarningLevel, WarningType } from "@baradun/contracts";
import { opsFetch, type OpsResult } from "./auth/ops-fetch";
import { MEMO_MAX } from "./inquiries";

// 해변 관리 화면이 쓰는 모양·규칙 (BRD-150, 화면 ADM-BCH). 브라우저에서도 쓰므로 node 모듈을 가져오지 않음
// - 해변 정보는 빌드 때 저장소 파일에서 읽음(beach-data.ts). 여기서는 고칠 수 없음(D15-4)
// - 지금 표시 상태: 운영 API가 게시본 status.json에서 그대로 옮겨 준 분류·사유. 화면에서 다시 계산하지 않음(G1)
//   못 받았거나 모양이 틀리거나 게시본에 해변이 없으면 판단불가 계열 '확인 못 함'(특보 없음처럼 보이지 않게)
// - 운영 메모: 운영 API(services/src/admin/beaches.ts). 글자 수 상한은 문의 내부 메모와 같음

export const METRIC_KEYS = [
  "waveHeight",
  "wavePeriod",
  "waveDirection",
  "waterTemp",
  "wind",
] as const;
export type MetricKey = (typeof METRIC_KEYS)[number];

export interface BeachStation {
  readonly id: string;
  readonly name: string;
  readonly distanceKm: number;
}

// beach-coverage.csv의 특보구역 대응 검증 한 줄(값은 파일 글 그대로)
export interface ZoneCheck {
  readonly zone: string | null;
  readonly status: string | null;
  readonly basis: string | null;
  readonly rule: string | null;
  readonly checkedAt: string | null;
}

export interface BeachCheck {
  readonly stage: string | null;
  readonly coordsSource: string | null;
  readonly sea: ZoneCheck;
  readonly land: ZoneCheck;
  readonly stationBasis: string | null;
  readonly responseCheck: string | null;
  readonly exclusion: string | null;
  readonly reviewReason: string | null;
}

export interface BeachSeason {
  readonly year: string;
  readonly status: "open" | "closed";
  readonly openDate: string | null;
  readonly closeDate: string | null;
}

export interface BeachRecord {
  readonly id: string;
  readonly slug: string;
  readonly nameKo: string;
  readonly nameEn: string;
  readonly sido: string;
  readonly sigungu: string;
  readonly coast: string;
  readonly lat: number;
  readonly lng: number;
  readonly hidden: boolean;
  readonly activities: readonly string[];
  readonly aliases: readonly string[];
  // beach-meta.json에 해변 칸이 있는지(없으면 별칭·운영 기간을 '연결 안 됨'으로)
  readonly inMeta: boolean;
  readonly zones: {
    readonly sea: string;
    readonly seaName: string | null;
    readonly land: string | null;
    readonly landName: string | null;
  };
  readonly stations: Readonly<Record<MetricKey, BeachStation | null>>;
  readonly photo: {
    readonly url: string;
    readonly source: string;
    readonly license: string;
    readonly title: string | null;
  } | null;
  // 운영 기간 일정이 없거나 연결되지 않으면 null
  readonly season: BeachSeason | null;
  // beach-coverage.csv에 줄이 없으면 null
  readonly check: BeachCheck | null;
}

export interface BeachSummary {
  readonly id: string;
  readonly slug: string;
  readonly nameKo: string;
  readonly sido: string;
  readonly sigungu: string;
  readonly hidden: boolean;
  readonly aliases: readonly string[];
  // beach-meta.json에 해변 칸이 있는지(없으면 별칭·운영 기간을 '없음'이 아니라 '연결 안 됨'으로)
  readonly inMeta: boolean;
  readonly seaZone: string;
  readonly seaZoneName: string | null;
  readonly seaStatus: string | null;
  readonly landStatus: string | null;
  // 배정된 관측 지표 수(5개 중)와 파고·파주기 측정소가 있는지
  readonly stations: number;
  readonly waveHeight: boolean;
  readonly wavePeriod: boolean;
  readonly season: BeachSeason | null;
  readonly hasPhoto: boolean;
  readonly hasCheck: boolean;
}

// ---- 저장소 링크 ----

export const REPO_URL = "https://github.com/404soonotfound/baradun_v2";

export const BEACH_FILES = {
  beach: (id: string) => `data/beaches/${id}.json`,
  meta: () => "data/beach-meta.json",
  coverage: () => "data/beach-coverage.csv",
} as const;
export type BeachFile = keyof typeof BEACH_FILES;

export function filePath(file: BeachFile, id: string): string {
  return BEACH_FILES[file](id);
}

// 'GitHub에서 수정': main 가지의 파일 편집 화면(로그인한 사람은 PR로 이어짐)
export function editUrl(file: BeachFile, id: string): string {
  return `${REPO_URL}/edit/main/${filePath(file, id)}`;
}

// 변경 이력: 그 파일의 커밋 기록(커밋마다 PR 링크가 붙음)
export function historyUrl(file: BeachFile, id: string): string {
  return `${REPO_URL}/commits/main/${filePath(file, id)}`;
}

// 목록 헤더 'GitHub에서 고치기' 링크: 저장소 해변 정의 폴더
export const BEACHES_TREE_URL = `${REPO_URL}/tree/main/data/beaches`;

// ---- 찾기·거르기·정렬·페이징 ----

// 시·도 지리 순서(동해안 위→아래, 남해 동→서, 서해 남→북, 제주)
export const SIDO_ORDER = [
  "강원",
  "경북",
  "울산",
  "부산",
  "경남",
  "전남",
  "전북",
  "충남",
  "인천",
  "제주",
] as const;

export const BEACH_PAGE_SIZE = 11;

export const BEACH_TABS = [
  "all",
  "undetermined",
  "unavailable",
  "hidden",
  "no_station",
  "unverified",
] as const;
export type BeachTab = (typeof BEACH_TABS)[number];

export const BEACH_SORTS = ["status", "region"] as const;
export type BeachSort = (typeof BEACH_SORTS)[number];

export interface BeachListQuery {
  readonly tab: BeachTab;
  readonly q: string;
  readonly sido: string | null;
  readonly zone: string | null;
  readonly sort: BeachSort;
  // 0부터 시작
  readonly page: number;
}

function compareSido(a: string, b: string): number {
  const ia = (SIDO_ORDER as readonly string[]).indexOf(a);
  const ib = (SIDO_ORDER as readonly string[]).indexOf(b);
  if (ia !== -1 && ib !== -1) return ia - ib;
  if (ia !== -1) return -1;
  if (ib !== -1) return 1;
  return a.localeCompare(b, "ko");
}

export function sidoList(
  beaches: readonly Pick<BeachSummary, "sido">[],
): string[] {
  return [...new Set(beaches.map((b) => b.sido))].sort(compareSido);
}

export interface ZoneOption {
  readonly code: string;
  readonly name: string | null;
}

export function zoneList(
  beaches: readonly Pick<BeachSummary, "seaZone" | "seaZoneName">[],
): ZoneOption[] {
  const byCode = new Map<string, string | null>();
  for (const b of beaches) {
    if (!byCode.has(b.seaZone)) byCode.set(b.seaZone, b.seaZoneName);
  }
  return [...byCode.entries()]
    .map(([code, name]) => ({ code, name }))
    .sort((a, b) => (a.name ?? a.code).localeCompare(b.name ?? b.code, "ko"));
}

export function isZoneVerified(
  beach: Pick<BeachSummary, "hasCheck" | "seaStatus" | "landStatus">,
): boolean {
  return (
    beach.hasCheck && beach.seaStatus === "검증" && beach.landStatus === "검증"
  );
}

export function zoneDisplayName(
  code: string,
  name: string | null,
  unknownLabel: string,
): string {
  return name ?? `${code} · ${unknownLabel}`;
}

// 이름·별칭·slug·ID·시군에서 찾음(띄어쓰기·대소문자 무시)
export function filterBeaches(
  beaches: readonly BeachSummary[],
  query: string,
  sido: string | null,
  zone: string | null = null,
): BeachSummary[] {
  const norm = (s: string) => s.replace(/\s+/g, "").toLowerCase();
  const q = norm(query);
  return beaches.filter(
    (b) =>
      (!sido || b.sido === sido) &&
      (!zone || b.seaZone === zone) &&
      (q === "" ||
        [b.nameKo, b.slug, b.id, b.sigungu, ...b.aliases].some((v) =>
          norm(v).includes(q),
        )),
  );
}

function compareByRegion(a: BeachSummary, b: BeachSummary): number {
  return (
    compareSido(a.sido, b.sido) ||
    a.sigungu.localeCompare(b.sigungu, "ko") ||
    a.nameKo.localeCompare(b.nameKo, "ko") ||
    a.id.localeCompare(b.id)
  );
}

// ---- 지금 표시 상태 ----

export type Category = "clear" | "unavailable" | "undetermined";

export interface PublishedEntry {
  readonly category: Category;
  readonly reasons: readonly Partial<Reason>[];
  // 게시 분류를 믿을 수 있는 마지막 시각(status.json validUntil)
  readonly validUntil: string;
}

// 게시본 manifest의 점검. 점검 중이면 앱은 해변 상태를 숨기고 점검 화면을 보여 줌(D23-11)
export interface PublishedMaintenance {
  readonly active: boolean;
  // 끝나는 예정 시각(UTC). 정하지 않았으면 null
  readonly until: string | null;
}

export type PublishedView =
  | {
      readonly available: true;
      readonly snapshotVersion: string;
      readonly generatedAt: string;
      readonly maintenance: PublishedMaintenance;
      readonly beaches: Readonly<Record<string, PublishedEntry>>;
    }
  | { readonly available: false; readonly reason: string };

const WARNING_TYPES: readonly WarningType[] = [
  "wind_wave",
  "strong_wind",
  "typhoon",
  "storm_surge",
  "tsunami",
];
const WARNING_LEVELS: readonly WarningLevel[] = [
  "advisory",
  "warning",
  "severe_warning",
];
const CATEGORIES: readonly Category[] = [
  "clear",
  "unavailable",
  "undetermined",
];

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

// 응답 모양 검사. 틀리면 null → 화면은 '불러오지 못함'과 같게 판단불가 계열로 보여 줌
// 해변 하나의 분류 값이 틀려도 그 해변만 빼지 않고 전체를 못 읽은 것으로 봄(서버도 계약 검사를 함)
export function parsePublished(value: unknown): PublishedView | null {
  if (!isRecord(value)) return null;
  if (value.available === false) {
    return {
      available: false,
      reason: typeof value.reason === "string" ? value.reason : "unknown",
    };
  }
  const { snapshotVersion, generatedAt, maintenance, beaches } = value;
  if (
    value.available !== true ||
    typeof snapshotVersion !== "string" ||
    typeof generatedAt !== "string" ||
    Number.isNaN(Date.parse(generatedAt)) ||
    !isRecord(maintenance) ||
    typeof maintenance.active !== "boolean" ||
    !(
      maintenance.until === null ||
      (typeof maintenance.until === "string" &&
        !Number.isNaN(Date.parse(maintenance.until)))
    ) ||
    !isRecord(beaches)
  ) {
    return null;
  }
  const out: Record<string, PublishedEntry> = {};
  for (const [id, entry] of Object.entries(beaches)) {
    if (
      !isRecord(entry) ||
      !(CATEGORIES as readonly unknown[]).includes(entry.category) ||
      !Array.isArray(entry.reasons) ||
      !entry.reasons.every(isRecord) ||
      typeof entry.validUntil !== "string" ||
      Number.isNaN(Date.parse(entry.validUntil))
    ) {
      return null;
    }
    out[id] = {
      category: entry.category as Category,
      reasons: entry.reasons as Partial<Reason>[],
      validUntil: entry.validUntil,
    };
  }
  return {
    available: true,
    snapshotVersion,
    generatedAt,
    maintenance: {
      active: maintenance.active,
      until: maintenance.until as string | null,
    },
    beaches: out,
  };
}

// 배지 글자(사유 먼저). 사용자 화면 배지와 같은 규칙(apps/web/src/lib/snapshot/view.ts reasonLabel)
// - 특보는 종류·단계를 아는 것만 이름으로. 모르면 지어내지 않고 일반 단어
// - 이용불가의 모르는 사유는 분류를 유지하고 '이용 제한'(아키텍처 9.1)
export type BadgeLabel =
  | { readonly kind: "clear" }
  | {
      readonly kind: "warning";
      readonly type: WarningType;
      readonly level: WarningLevel;
    }
  | { readonly kind: "warning_unknown" }
  | { readonly kind: "observation_delayed" }
  | { readonly kind: "restricted" }
  | { readonly kind: "unconfirmed" };

// 색 이름: 특보 없음 / 이용불가 / 판단불가(특보 확인 못 함·모름) / 판단불가(관측 지연)
export type BadgeTone = "clear" | "blocked" | "unknown" | "stale";

function generic(category: Category): BadgeLabel {
  if (category === "unavailable") return { kind: "restricted" };
  if (category === "undetermined") return { kind: "unconfirmed" };
  return { kind: "clear" };
}

function reasonLabel(reason: Partial<Reason>, category: Category): BadgeLabel {
  switch (reason.code) {
    case "warning":
      if (
        (WARNING_TYPES as readonly unknown[]).includes(reason.type) &&
        (WARNING_LEVELS as readonly unknown[]).includes(reason.level)
      ) {
        return {
          kind: "warning",
          type: reason.type as WarningType,
          level: reason.level as WarningLevel,
        };
      }
      break;
    case "warning_unknown":
      return { kind: "warning_unknown" };
    case "observation_delayed":
      return { kind: "observation_delayed" };
  }
  return generic(category);
}

// 사유 목록(항상 하나 이상). 특보 없음은 사유가 있어도 '특보 없음' 하나
export function reasonLabels(
  entry: PublishedEntry,
): [BadgeLabel, ...BadgeLabel[]] {
  if (entry.category === "clear") return [{ kind: "clear" }];
  const [first, ...rest] = entry.reasons.map((r) =>
    reasonLabel(r, entry.category),
  );
  return first ? [first, ...rest] : [generic(entry.category)];
}

export function badgeTone(label: BadgeLabel): BadgeTone {
  switch (label.kind) {
    case "clear":
      return "clear";
    case "warning":
    case "restricted":
      return "blocked";
    case "warning_unknown":
    case "unconfirmed":
      return "unknown";
    case "observation_delayed":
      return "stale";
  }
}

// 해변 하나의 지금 표시 상태
// - loading: 아직 응답 없음
// - unconfirmed: 게시본을 못 받음·모양이 틀림·게시본에 해변이 없음 → 판단불가 계열 '확인 못 함'
// - published: 게시본 분류·사유 그대로(G1, 화면에서 다시 계산하지 않음)
//   validUntil이 지났으면 expired만 켜고 분류는 그대로 둠. 화면은 분류와 따로 '유효 시각 지남'을 알림
// - maintenance: 게시본이 점검 중. 앱은 해변 상태를 숨기므로 지금 표시 상태는 '점검 중 · 앱에 표시 안 함'
//   마지막 게시 분류(last)는 바꾸지 않고 보조로 보여 줌(D23-11, G1)
export type PublishedDisplay = {
  readonly kind: "published";
  readonly category: Category;
  readonly labels: [BadgeLabel, ...BadgeLabel[]];
  readonly reasons: readonly Partial<Reason>[];
  readonly validUntil: string;
  readonly expired: boolean;
};

// 점검 중에 함께 보여 주는 마지막 게시 분류(게시본에 해변이 없으면 '게시본에 없음')
export type LastDisplay =
  PublishedDisplay | { readonly kind: "unconfirmed"; readonly why: "missing" };

export type BeachDisplay =
  | { readonly kind: "loading" }
  | {
      readonly kind: "unconfirmed";
      readonly why: "unavailable" | "missing";
    }
  | PublishedDisplay
  | {
      readonly kind: "maintenance";
      readonly until: string | null;
      readonly last: LastDisplay;
    };

export function displayOf(
  published: PublishedView | null | "loading",
  id: string,
  nowMs: number = Date.now(),
): BeachDisplay {
  if (published === "loading") return { kind: "loading" };
  if (!published || !published.available) {
    return { kind: "unconfirmed", why: "unavailable" };
  }
  const last = publishedDisplay(published.beaches[id], nowMs);
  if (published.maintenance.active) {
    return { kind: "maintenance", until: published.maintenance.until, last };
  }
  return last;
}

function publishedDisplay(
  entry: PublishedEntry | undefined,
  nowMs: number,
): LastDisplay {
  if (!entry) return { kind: "unconfirmed", why: "missing" };
  return {
    kind: "published",
    category: entry.category,
    labels: reasonLabels(entry),
    reasons: entry.reasons,
    validUntil: entry.validUntil,
    // 시각을 읽을 수 없으면 지난 것으로 봄(parsePublished가 이미 막지만 한 번 더)
    expired: !(nowMs <= Date.parse(entry.validUntil)),
  };
}

export function fetchPublished(
  accessToken: () => Promise<string | null>,
): Promise<OpsResult<unknown>> {
  return opsFetch("/ops/beaches/published", accessToken);
}

// ---- 목록 탭·정렬·주소 쿼리 ----

function effectiveDisplay(
  display: BeachDisplay,
):
  | PublishedDisplay
  | { readonly kind: "unconfirmed"; readonly why: "unavailable" | "missing" }
  | null {
  if (display.kind === "loading") return null;
  return display.kind === "maintenance" ? display.last : display;
}

export function delayedObservedAt(display: BeachDisplay): string | null {
  const eff = effectiveDisplay(display);
  if (!eff || eff.kind !== "published") return null;
  for (const reason of eff.reasons) {
    if (
      reason.code === "observation_delayed" &&
      typeof reason.at === "string" &&
      !Number.isNaN(Date.parse(reason.at))
    ) {
      return reason.at;
    }
  }
  return null;
}

// 비노출 해변은 게시본 status.json에 원래 없으므로 게시본에 빠진 이유만으로 판단불가로 치지 않음
// 단, 게시본 자체를 못 받은 경우(why === "unavailable")는 확인할 수 없어 판단불가로 봄
export function effectiveCategory(
  beach: Pick<BeachSummary, "hidden">,
  display: BeachDisplay,
): Category | "hidden" | null {
  const eff = effectiveDisplay(display);
  if (!eff) return null;
  if (eff.kind === "unconfirmed") {
    if (beach.hidden && eff.why === "missing") return "hidden";
    return "undetermined";
  }
  return eff.category;
}

export function matchesTab(
  beach: BeachSummary,
  tab: BeachTab,
  display: BeachDisplay,
): boolean {
  switch (tab) {
    case "all":
      return true;
    case "undetermined":
      return effectiveCategory(beach, display) === "undetermined";
    case "unavailable":
      return effectiveCategory(beach, display) === "unavailable";
    case "hidden":
      return beach.hidden;
    case "no_station":
      return !beach.waveHeight;
    case "unverified":
      return !isZoneVerified(beach);
  }
}

export function tabCounts(
  beaches: readonly BeachSummary[],
  published: PublishedView | null | "loading",
  nowMs: number = Date.now(),
): Record<BeachTab, number | null> {
  const ready = published !== "loading";
  const counts: Record<BeachTab, number | null> = {
    all: beaches.length,
    undetermined: ready ? 0 : null,
    unavailable: ready ? 0 : null,
    hidden: 0,
    no_station: 0,
    unverified: 0,
  };
  for (const b of beaches) {
    if (b.hidden) counts.hidden = (counts.hidden ?? 0) + 1;
    if (!b.waveHeight) counts.no_station = (counts.no_station ?? 0) + 1;
    if (!isZoneVerified(b)) counts.unverified = (counts.unverified ?? 0) + 1;
    if (ready) {
      const cat = effectiveCategory(b, displayOf(published, b.id, nowMs));
      if (cat === "undetermined") {
        counts.undetermined = (counts.undetermined ?? 0) + 1;
      } else if (cat === "unavailable") {
        counts.unavailable = (counts.unavailable ?? 0) + 1;
      }
    }
  }
  return counts;
}

// 앱 표시 순: 게시본 이상(판단불가 → 이용불가) → 미확인 → 비노출 → 특보 없음, 같은 묶음은 지리 순서
function statusRank(beach: BeachSummary, display: BeachDisplay): number {
  const eff = effectiveDisplay(display);
  if (!eff) return beach.hidden ? 3 : 2;
  if (eff.kind === "published") {
    if (eff.category === "undetermined") return 0;
    if (eff.category === "unavailable") return 1;
    return beach.hidden ? 3 : 4;
  }
  if (beach.hidden && eff.why === "missing") return 3;
  return 2;
}

export function sortBeaches(
  beaches: readonly BeachSummary[],
  sort: BeachSort,
  published: PublishedView | null | "loading",
  nowMs: number = Date.now(),
): BeachSummary[] {
  const copy = [...beaches];
  if (sort === "region") return copy.sort(compareByRegion);
  const rankOf = new Map(
    copy.map((b) => [b.id, statusRank(b, displayOf(published, b.id, nowMs))]),
  );
  return copy.sort((a, b) => {
    const diff = (rankOf.get(a.id) ?? 4) - (rankOf.get(b.id) ?? 4);
    return diff !== 0 ? diff : compareByRegion(a, b);
  });
}

export function queryBeaches(
  beaches: readonly BeachSummary[],
  options: Pick<BeachListQuery, "tab" | "q" | "sido" | "zone" | "sort">,
  published: PublishedView | null | "loading",
  nowMs: number = Date.now(),
): BeachSummary[] {
  const filtered = filterBeaches(
    beaches,
    options.q,
    options.sido,
    options.zone,
  ).filter((b) =>
    matchesTab(b, options.tab, displayOf(published, b.id, nowMs)),
  );
  return sortBeaches(filtered, options.sort, published, nowMs);
}

export function parseBeachQuery(params: {
  get(key: string): string | null;
}): BeachListQuery {
  const rawTab = params.get("tab");
  const tab: BeachTab = (BEACH_TABS as readonly string[]).includes(rawTab ?? "")
    ? (rawTab as BeachTab)
    : "all";
  const q = params.get("q") ?? "";
  const rawSido = params.get("sido")?.trim() ?? "";
  const rawZone = params.get("zone")?.trim() ?? "";
  const rawSort = params.get("sort");
  const sort: BeachSort = rawSort === "region" ? "region" : "status";
  const rawPage = params.get("page")?.trim() ?? "";
  const page = /^[1-9]\d*$/.test(rawPage) ? Number(rawPage) - 1 : 0;
  return {
    tab,
    q,
    sido: rawSido !== "" ? rawSido : null,
    zone: rawZone !== "" ? rawZone : null,
    sort,
    page,
  };
}

export function beachListHref(query: BeachListQuery): string {
  const sp = new URLSearchParams();
  if (query.tab !== "all") sp.set("tab", query.tab);
  if (query.q !== "") sp.set("q", query.q);
  if (query.sido !== null) sp.set("sido", query.sido);
  if (query.zone !== null) sp.set("zone", query.zone);
  if (query.sort !== "status") sp.set("sort", query.sort);
  if (query.page > 0) sp.set("page", String(query.page + 1));
  const qs = sp.toString();
  return qs ? `/beaches/?${qs}` : "/beaches/";
}

// ---- 운영 메모 ----

// 문의 내부 메모 상한을 그대로 씀(services/src/admin/inquiries.ts MEMO_MAX와 같음). 해변 메모 상한은 노션에 따로 없음
export const BEACH_MEMO_MAX = MEMO_MAX;

export interface BeachMemo {
  readonly beachId: string;
  readonly memo: string | null;
  readonly version: number;
  readonly updatedAt: string | null;
}

export function parseBeachMemo(value: unknown, id: string): BeachMemo | null {
  if (!isRecord(value)) return null;
  const { beachId, memo, version, updatedAt } = value;
  if (
    beachId !== id ||
    (memo !== null && typeof memo !== "string") ||
    !Number.isSafeInteger(version) ||
    (version as number) < 0 ||
    (updatedAt !== null && typeof updatedAt !== "string")
  ) {
    return null;
  }
  return { beachId, memo, version: version as number, updatedAt };
}

export function fetchBeachMemo(
  accessToken: () => Promise<string | null>,
  id: string,
): Promise<OpsResult<unknown>> {
  return opsFetch(`/ops/beaches/${encodeURIComponent(id)}/memo`, accessToken);
}

export function saveBeachMemo(
  accessToken: () => Promise<string | null>,
  id: string,
  body: { readonly version: number; readonly memo: string | null },
  idempotencyKey: string,
): Promise<OpsResult<{ beachId: string; version: number }>> {
  return opsFetch(`/ops/beaches/${encodeURIComponent(id)}/memo`, accessToken, {
    method: "PUT",
    body,
    idempotencyKey,
  });
}

export const charCount = (text: string) => [...text].length;
