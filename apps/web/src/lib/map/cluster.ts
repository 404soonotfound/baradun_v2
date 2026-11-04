import type { LatLng } from "@/lib/geo";
import { boundsOf, type LngLatBox } from "./bounds";

// 지도 마커 묶음 (BRD-114 · 결정 기록 12장 결정 8)
// 낮은 확대 단계에서 화면에서 겹치는 마커를 숫자 묶음 하나로 보여 줌. 확대 11 이상은 늘 개별 마커
// 묶음은 해변 수만 셈: 대표 상태·합산 판단을 만들지 않음(분류·사유는 개별 마커와 목록·카드에만)

// 이 확대 단계부터 묶지 않음(마커 이름이 붙는 단계와 같음, 결정 7)
export const CLUSTER_MAX_ZOOM = 11;

// 마커 가운데끼리 가로·세로 모두 이보다 가까우면(px) 묶음. 누르는 자리(44px 정사각형)가 겹치지 않는 거리
export const CLUSTER_RADIUS_PX = 44;

// MapLibre 타일 한 장의 화면 크기(px). 확대 z에서 세계 너비 = 512 × 2^z
const TILE_SIZE = 512;

export type MapGroup<T> =
  | { kind: "single"; item: T }
  | {
      kind: "cluster";
      key: string;
      items: T[];
      center: LatLng;
      bounds: LngLatBox;
    };

// [1] 좌표 → 확대 z의 화면 좌표(px, 웹 메르카토르)
function project({ lat, lng }: LatLng, zoom: number) {
  const size = TILE_SIZE * 2 ** zoom;
  const sin = Math.sin((lat * Math.PI) / 180);
  return {
    x: ((lng + 180) / 360) * size,
    y: (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * size,
  };
}

// [1-1] 화면 좌표 → 좌표(project의 반대). 묶음 자리를 화면 계산과 같은 곳에 두려고 씀
function unproject({ x, y }: { x: number; y: number }, zoom: number): LatLng {
  const size = TILE_SIZE * 2 ** zoom;
  const n = Math.PI - (2 * Math.PI * y) / size;
  return {
    lat: (180 / Math.PI) * Math.atan(Math.sinh(n)),
    lng: (x / size) * 360 - 180,
  };
}

// [2] 묶기. keep의 해변(고른·가리킨 마커)은 늘 따로 둠(강조한 마커가 묶음에 숨지 않게)
// 화면에서 가장 가까운 두 무리를 반경 안에 없을 때까지 하나씩 합침(무리 자리 = 속한 마커 화면 좌표의 평균)
// 거리는 가로·세로 차이 중 큰 값: 누르는 자리가 정사각형이라 대각선으로 반경보다 멀어도 겹칠 수 있음
// → 남은 마커·묶음끼리는 누르는 자리가 겹치지 않음(WCAG 2.5.8)
// 같은 거리면 id 순서가 앞인 쪽부터 → 같은 입력이면 늘 같은 결과
export function clusterMarkers<T extends { id: string; coords: LatLng }>(
  items: readonly T[],
  zoom: number,
  keep: ReadonlySet<string> = new Set(),
  radius = CLUSTER_RADIUS_PX,
): MapGroup<T>[] {
  if (!(zoom < CLUSTER_MAX_ZOOM)) {
    return items.map((item) => ({ kind: "single", item }));
  }
  const sorted = [...items].sort((a, b) => a.id.localeCompare(b.id));
  const kept = sorted.filter((item) => keep.has(item.id));
  const heaps = sorted
    .filter((item) => !keep.has(item.id))
    .map((item) => ({ members: [item], ...project(item.coords, zoom) }));

  for (;;) {
    let best: { i: number; j: number; distance: number } | null = null;
    for (let i = 0; i < heaps.length; i++) {
      for (let j = i + 1; j < heaps.length; j++) {
        const a = heaps[i]!;
        const b = heaps[j]!;
        const distance = Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
        if (distance < radius && (best === null || distance < best.distance))
          best = { i, j, distance };
      }
    }
    if (best === null) break;
    const a = heaps[best.i]!;
    const b = heaps[best.j]!;
    const total = a.members.length + b.members.length;
    heaps[best.i] = {
      members: [...a.members, ...b.members],
      x: (a.x * a.members.length + b.x * b.members.length) / total,
      y: (a.y * a.members.length + b.y * b.members.length) / total,
    };
    heaps.splice(best.j, 1);
  }

  const groups: MapGroup<T>[] = kept.map((item) => ({ kind: "single", item }));
  for (const { members, x, y } of heaps) {
    const [first] = members;
    if (members.length === 1 && first) {
      groups.push({ kind: "single", item: first });
      continue;
    }
    const ordered = members.sort((a, b) => a.id.localeCompare(b.id));
    const coords = ordered.map((member) => member.coords);
    groups.push({
      kind: "cluster",
      key: ordered.map((member) => member.id).join(","),
      items: ordered,
      center: unproject({ x, y }, zoom),
      bounds: boundsOf(coords),
    });
  }
  return groups;
}
