import type { BeachSummary, RegionPart } from "@/lib/beach-summary";
// 타입만 가져옴(빌드 때 지워져 서버 부품에서도 훅 파일을 부르지 않음)
import type { LocationState } from "@/lib/location";

// 지역 목록 계산 (BRD-26·27). React를 쓰지 않는 순수 함수만 모음
// 서버 부품(AppShell)도 부르기 때문에 lib/region.ts(useSyncExternalStore 사용)와 나눔
// 서버 부품이 React 훅을 import한 파일을 부르면 Next.js 빌드 오류

// [2] 시·도 지리 순서. as const = 글자를 그 값 그대로(예: "강원") 타입으로 고정하고 읽기 전용으로 만듦
export const SIDO_ORDER = [
  "강원",
  "경북",
  "울산", // 동해안 위→아래
  "부산",
  "경남",
  "전남", // 남해 동→서
  "전북",
  "충남",
  "인천", // 서해 남→북(해안선을 이어서. 방향은 확인 필요)
  "제주",
] as const;

// [3] 저장하는 값. sigungu는 시·군을 아직 안 골랐으면 null. 둘 다 한국어 원본 이름(key)
export type SavedRegion = { sido: string; sigungu: string | null };

// [3-1] 지역 고르기 시트에서 '전국'을 고른 것(BRD-127). 시·도 지역과 같은 저장 칸에 이 글자로 저장
// 저장값이 없을 때의 전국(기본값)과 달리, 위치가 있어도 전국을 보여줌
export const NATIONWIDE = "nationwide";
export type RegionChoice = SavedRegion | typeof NATIONWIDE;

// [3-2] 저장 글자 → 고른 값. 모양이 다르면 null(고르지 않은 것으로 봄 → 홈 기본값)
// 전국은 JSON 글자 "nationwide". 이 값을 모르는 옛 화면은 고르지 않은 것으로 읽음
export function parseRegionChoice(raw: string | null): RegionChoice | null {
  if (raw === null) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (value === NATIONWIDE) return NATIONWIDE;
    if (typeof value !== "object" || value === null) return null;
    // as Record<string, unknown> = "어떤 칸이든 있을 수 있는 객체"로 보고 칸을 꺼냄
    const { sido, sigungu } = value as Record<string, unknown>;
    if (typeof sido !== "string") return null;
    return { sido, sigungu: typeof sigungu === "string" ? sigungu : null };
  } catch {
    return null;
  }
}

// [4] 해변 목록에서 칩으로 보여줄 시·도 목록. 해변이 있는 시·도만, SIDO_ORDER 순
// 순서표에 없는 시·도(새로 생긴 이름 등)는 숨기지 않고 맨 뒤에 붙임
export function regionChips(beaches: readonly BeachSummary[]): RegionPart[] {
  // Map = 키 → 값 모음. 같은 시·도는 하나만 남음
  const found = new Map<string, RegionPart>();
  for (const beach of beaches) found.set(beach.sido.key, beach.sido);
  // indexOf가 못 찾으면 -1 → 맨 뒤 순번
  const rank = (key: string) => {
    const index = (SIDO_ORDER as readonly string[]).indexOf(key);
    return index === -1 ? SIDO_ORDER.length : index;
  };
  // [...found.values()] = Map의 값들을 배열로. sort는 앨의 순번이 작은 쪽이 앞
  return [...found.values()].sort((a, b) => rank(a.key) - rank(b.key));
}

// [5] 저장된 지역이 지금 해변 목록에 없으면(해변이 빠진 경우 등) 고르지 않은 것으로 봄
// 시·군만 없어졌으면 시·도는 유지
export function validRegion(
  saved: SavedRegion | null,
  beaches: readonly BeachSummary[],
): SavedRegion | null {
  if (saved === null) return null;
  // some = 하나라도 조건에 맞으면 true
  if (!beaches.some((beach) => beach.sido.key === saved.sido)) return null;
  if (saved.sigungu === null) return saved;
  const hasSigungu = beaches.some(
    (beach) =>
      beach.sido.key === saved.sido && beach.sigungu.key === saved.sigungu,
  );
  return hasSigungu ? saved : { sido: saved.sido, sigungu: null };
}

// [6] 시·도 하나와 그 안의 시·군 목록. 지역 고르기 시트(RegionSheet)가 받는 모양
export type RegionGroup = { sido: RegionPart; sigungu: RegionPart[] };

// [7] 해변 목록 → 시·도별 시·군 묶음. 시·도는 regionChips 순서, 시·군은 이름 순
export function regionGroups(beaches: readonly BeachSummary[]): RegionGroup[] {
  return regionChips(beaches).map((sido) => {
    const found = new Map<string, RegionPart>();
    for (const beach of beaches) {
      if (beach.sido.key === sido.key)
        found.set(beach.sigungu.key, beach.sigungu);
    }
    // localeCompare = 글자 사전 순 비교(가나다·ABC)
    const sigungu = [...found.values()].sort((a, b) =>
      a.label.localeCompare(b.label),
    );
    return { sido, sigungu };
  });
}

// [8] 고른 지역의 화면 이름: "강원" 또는 "강원 양양군". 목록에 없으면 null
export function regionName(
  groups: readonly RegionGroup[],
  region: SavedRegion,
): string | null {
  const group = groups.find((item) => item.sido.key === region.sido);
  if (!group) return null;
  if (region.sigungu === null) return group.sido.label;
  const sigungu = group.sigungu.find((item) => item.key === region.sigungu);
  return sigungu ? `${group.sido.label} ${sigungu.label}` : group.sido.label;
}

// [9] 해변이 고른 지역 안에 있는지. 시·군을 안 골랐으면 시·도만 비교
export function inRegion(beach: BeachSummary, region: SavedRegion): boolean {
  return (
    beach.sido.key === region.sido &&
    (region.sigungu === null || beach.sigungu.key === region.sigungu)
  );
}

// [10] 홈 바다 카드·개수가 보여줄 범위 (BRD-127 · 2026-10-29 사용자 요청: 기본값 전국)
//   region     = 고른 시·도·시·군(기기 저장값 그대로)
//   nationwide = 전국. 시트에서 고른 전국이거나, 고른 지역이 없고 위치도 없을 때(기본값)
//   nearby     = 고른 지역이 없고 위치가 있거나 확인 중(가까운 바다). 위치 흐름은 바꾸지 않음
// chosen = 전국을 시트에서 직접 고름(위치를 켜도 전국 유지). false = 기본값(위치를 켜면 가까운 바다로)
export type HomeScope =
  | { kind: "region"; region: SavedRegion }
  | { kind: "nationwide"; chosen: boolean }
  | { kind: "nearby" };

export function homeScope(
  saved: RegionChoice | null,
  beaches: readonly BeachSummary[],
  status: LocationState["status"],
): HomeScope {
  if (saved === NATIONWIDE) return { kind: "nationwide", chosen: true };
  // 목록에 없어진 지역·모양이 다른 저장값은 고르지 않은 것으로 봄(validRegion·parseRegionChoice)
  const region = validRegion(saved, beaches);
  if (region !== null) return { kind: "region", region };
  // 권한 확인 중·받는 중은 아직 모름 → 가까운 바다 자리를 잡아 둠(전국이 잠깐 보였다 바뀌지 않게)
  if (status === "ready" || status === "locating" || status === "checking")
    return { kind: "nearby" };
  return { kind: "nationwide", chosen: false };
}

// [11] 범위 안 해변(이름 순). 지역은 그 지역 해변, 전국은 공개 해변 전체, 가까운 바다는 빈 목록(거리 순은 부르는 쪽)
// 수영은 전체 해변(B7), 서핑·스쿠버는 그 활동이 확인된 해변만
export function scopeBeaches(
  beaches: readonly BeachSummary[],
  scope: HomeScope,
  activity: BeachSummary["activities"][number],
): BeachSummary[] {
  if (scope.kind === "nearby") return [];
  return beaches
    .filter(
      (beach) =>
        (scope.kind === "nationwide" || inRegion(beach, scope.region)) &&
        (activity === "swimming" || beach.activities.includes(activity)),
    )
    .sort((a, b) => a.name.localeCompare(b.name));
}
