import type { BeachSummary, RegionPart } from "@/lib/beach-summary";

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
