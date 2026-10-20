import type {
  NearbyWarningType,
  WarningLevel,
  WarningType,
} from "@baradun/contracts";

// 기상청 getPwnCd 코드표 (기상특보 조회서비스 활용가이드 응답 명세, 아키텍처 4장)
// 값은 모두 문자열로 옴(BRD-16 픽스처). 표에 없는 코드는 null → 부르는 쪽이 warning_unknown으로 기록

// 특보 종류(warnVar) 중 판단하는 것 (B3)
// 지진해일은 getPwnCd에 없음 → getTsunamiMsg에서 받음(결정 기록 11장 10/20)
export const JUDGED_TYPES = {
  "1": "strong_wind", // 강풍
  "5": "storm_surge", // 폭풍해일
  "6": "wind_wave", // 풍랑
  "7": "typhoon", // 태풍
} as const satisfies Record<string, WarningType>;

// 판단에 쓰지 않고 주변 특보로만 보이는 것 (B3, 열대야는 10/20 추가)
export const NEARBY_TYPES = {
  "2": "heavy_rain", // 호우
  "3": "cold_wave", // 한파
  "4": "dry", // 건조
  "8": "heavy_snow", // 대설
  "9": "yellow_dust", // 황사
  "12": "heat_wave", // 폭염
  "13": "tropical_night", // 열대야 (2026-06-01부터)
} as const satisfies Record<string, NearbyWarningType>;

// 표에서 key 찾기. 없으면 null
// Object.hasOwn: 객체가 직접 가진 key인지만 봄 → "toString"처럼 물려받은 이름은 false
function lookup<T extends Record<string, string>>(
  table: T,
  key: string,
): T[keyof T] | null {
  return Object.hasOwn(table, key) ? (table[key] as T[keyof T]) : null;
}

// 종류 판별 결과: 판단 / 주변 / 모름(원래 코드 보관)
export type WarningKind =
  | { group: "judged"; type: WarningType }
  | { group: "nearby"; type: NearbyWarningType }
  | { group: "unknown"; raw: string };

export function warningKind(warnVar: string): WarningKind {
  const judged = lookup(JUDGED_TYPES, warnVar);
  if (judged) return { group: "judged", type: judged };
  const nearby = lookup(NEARBY_TYPES, warnVar);
  if (nearby) return { group: "nearby", type: nearby };
  return { group: "unknown", raw: warnVar };
}

// 특보 강도(warnStress) → 단계. 중대경보는 10/20 계약에 추가
export const LEVELS = {
  "0": "advisory", // 주의보
  "1": "warning", // 경보
  "2": "severe_warning", // 중대경보
} as const satisfies Record<string, WarningLevel>;

export function warningLevel(warnStress: string): WarningLevel | null {
  return lookup(LEVELS, warnStress);
}

// 특보 발표코드(command) → 동작. 3 연장은 해제예고가 아님(아키텍처 4장)
export type PwnAction =
  | "issue" // 1 발표
  | "release" // 2 해제
  | "extend" // 3 연장
  | "correct" // 6 정정
  | "change_issue" // 7 변경발표
  | "change_release"; // 8 변경해제

export const ACTIONS = {
  "1": "issue",
  "2": "release",
  "3": "extend",
  "6": "correct",
  "7": "change_issue",
  "8": "change_release",
} as const satisfies Record<string, PwnAction>;

export function pwnAction(command: string): PwnAction | null {
  return lookup(ACTIONS, command);
}
