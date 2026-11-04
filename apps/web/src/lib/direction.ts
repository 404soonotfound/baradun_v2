// 방향(도) → 16방위 (BRD-182 · 결정 기록 18장 D18-3 '파도 방향은 큰 '남남동' + 작은 '쪽에서'')
// 파향(kma_buoy WO)은 파도가 오는 쪽(도, 0~360). 범위 밖 값은 publisher가 값으로 게시하지 않음
//   (services core/observations/values.ts, 결정 기록 11장 BRD-19). 그래도 들어오면 360으로 나눈 나머지로 읽음
// 22.5° 칸마다 한 방위. 칸 경계(11.25° 등)는 시계 방향 다음 칸으로(Math.round)
export const COMPASS_POINTS = [
  "N",
  "NNE",
  "NE",
  "ENE",
  "E",
  "ESE",
  "SE",
  "SSE",
  "S",
  "SSW",
  "SW",
  "WSW",
  "W",
  "WNW",
  "NW",
  "NNW",
] as const;

export type CompassPoint = (typeof COMPASS_POINTS)[number];

export function compassPoint(degrees: number): CompassPoint {
  const index = Math.round((((degrees % 360) + 360) % 360) / 22.5) % 16;
  // noUncheckedIndexedAccess: index는 0~15라 늘 있음
  return COMPASS_POINTS[index] ?? "N";
}
