import type { Reason, WarningLevel, WarningType } from "@baradun/contracts";
import { opsFetch, type OpsResult } from "./auth/ops-fetch";

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
  readonly zones: { readonly sea: string; readonly land: string | null };
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
  readonly seaZone: string;
  readonly seaStatus: string | null;
  readonly landStatus: string | null;
  // 배정된 관측 지표 수(5개 중)와 파고 측정소가 있는지
  readonly stations: number;
  readonly waveHeight: boolean;
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

// ---- 찾기·거르기 ----

export function sidoList(beaches: readonly BeachSummary[]): string[] {
  return [...new Set(beaches.map((b) => b.sido))].sort((a, b) =>
    a.localeCompare(b, "ko"),
  );
}

// 이름·별칭·slug·ID·시군에서 찾음(띄어쓰기·대소문자 무시)
export function filterBeaches(
  beaches: readonly BeachSummary[],
  query: string,
  sido: string | null,
): BeachSummary[] {
  const norm = (s: string) => s.replace(/\s+/g, "").toLowerCase();
  const q = norm(query);
  return beaches.filter(
    (b) =>
      (!sido || b.sido === sido) &&
      (q === "" ||
        [b.nameKo, b.slug, b.id, b.sigungu, ...b.aliases].some((v) =>
          norm(v).includes(q),
        )),
  );
}

// ---- 지금 표시 상태 ----

export type Category = "clear" | "unavailable" | "undetermined";

export interface PublishedEntry {
  readonly category: Category;
  readonly reasons: readonly Partial<Reason>[];
}

export type PublishedView =
  | {
      readonly available: true;
      readonly snapshotVersion: string;
      readonly generatedAt: string;
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
  const { snapshotVersion, generatedAt, beaches } = value;
  if (
    value.available !== true ||
    typeof snapshotVersion !== "string" ||
    typeof generatedAt !== "string" ||
    Number.isNaN(Date.parse(generatedAt)) ||
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
      !entry.reasons.every(isRecord)
    ) {
      return null;
    }
    out[id] = {
      category: entry.category as Category,
      reasons: entry.reasons as Partial<Reason>[],
    };
  }
  return { available: true, snapshotVersion, generatedAt, beaches: out };
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
// - published: 게시본 분류·사유 그대로
export type BeachDisplay =
  | { readonly kind: "loading" }
  | {
      readonly kind: "unconfirmed";
      readonly why: "unavailable" | "missing";
    }
  | {
      readonly kind: "published";
      readonly category: Category;
      readonly labels: [BadgeLabel, ...BadgeLabel[]];
      readonly reasons: readonly Partial<Reason>[];
    };

export function displayOf(
  published: PublishedView | null | "loading",
  id: string,
): BeachDisplay {
  if (published === "loading") return { kind: "loading" };
  if (!published || !published.available) {
    return { kind: "unconfirmed", why: "unavailable" };
  }
  const entry = published.beaches[id];
  if (!entry) return { kind: "unconfirmed", why: "missing" };
  return {
    kind: "published",
    category: entry.category,
    labels: reasonLabels(entry),
    reasons: entry.reasons,
  };
}

export function fetchPublished(
  accessToken: () => Promise<string | null>,
): Promise<OpsResult<unknown>> {
  return opsFetch("/ops/beaches/published", accessToken);
}

// ---- 운영 메모 ----

// 문의 내부 메모 상한과 같음(services/src/admin/inquiries.ts MEMO_MAX). 해변 메모 상한은 노션에 따로 없음
export const BEACH_MEMO_MAX = 2000;

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
