import { minutesAgo } from "@/lib/snapshot/clock";
import type { MetricKey, MetricView } from "@/lib/snapshot/view";

// [1] 가까운 바다 카드 지표 한 칸의 상태 (BRD-129 · Codex P2)
// 값이 없을 때 지표를 빼지 않고 이름을 남긴 채 이유를 보여주려고 상태를 나눔
//   value: 값과 단위 · none: '가까운 관측 없음'(20km 안 측정소 없음) · delayed: '늦어짐'(게시된 지연·지표별 만료)
//   missing: "–"(읽을 수 없는 값, 출처를 붙일 수 없는 값) · loading: 아직 받지 못함
export type CardMetric =
  | { kind: "value"; value: number; unit: string; observedAt: string }
  | { kind: "none" }
  | { kind: "delayed" }
  | { kind: "missing" }
  | { kind: "loading" };

// metric: 지금 화면 상태의 지표(null = 불러오는 중) · hasStation: 그 지표의 측정소 정보가 있는지
// 측정소 정보가 없는 값은 출처를 붙일 수 없어 보이지 않음(결측과 같은 "–")
export function cardMetric(
  metric: MetricView | null,
  hasStation: boolean,
): CardMetric {
  if (metric === null) return { kind: "loading" };
  switch (metric.kind) {
    case "value":
      return hasStation
        ? {
            kind: "value",
            value: metric.value,
            unit: metric.unit,
            observedAt: metric.observedAt,
          }
        : { kind: "missing" };
    case "none":
      return { kind: "none" };
    case "delayed":
      return { kind: "delayed" };
    case "hidden":
      return { kind: "missing" };
  }
}

// [2] 관측 시각 묶음 (Codex P1 · #105 결정 1 안에서 지표별 시각을 보이기)
// 카드에 값이 보이는 지표를 'n분 전'이 같은 것끼리 묶음(같은 측정소·같은 시각이면 한 묶음). 순서는 처음 나온 순
// 첫 묶음이 대표 시각('n분 전 측정'), 나머지는 '수온 12분 전'처럼 짧게. 시각을 읽을 수 없으면 minutes: null('측정 시각 모름')
export type TimeGroup = { keys: MetricKey[]; minutes: number | null };

export function timeGroups(
  items: readonly { key: MetricKey; observedAt: string }[],
  nowMs: number,
): TimeGroup[] {
  const groups: TimeGroup[] = [];
  for (const item of items) {
    const minutes = minutesAgo(item.observedAt, nowMs);
    const found = groups.find((group) => group.minutes === minutes);
    if (found) found.keys.push(item.key);
    else groups.push({ keys: [item.key], minutes });
  }
  return groups;
}

// [3] 값이 하나도 없는 카드의 이유 묶음 (BRD-129 · 사용자 확인 10/29)
// 같은 이유는 한 줄로: '가까운 관측 없음(파고·파주기·수온)'. 이유가 섞이면 이유별로 나눔(처음 나온 순)
// 다음 행동은 이유에 맞게: 지연·결측이 하나라도 있으면 새 값을 기다림, 모두 '가까운 관측 없음'이면
// 기다려도 값이 오지 않으므로(20km 안 측정소 없음) 특보 배지를 보라는 사실 문구
export type StatusGroup = {
  kind: "none" | "delayed" | "missing";
  keys: MetricKey[];
};

export function statusGroups(
  items: readonly { key: MetricKey; metric: CardMetric }[],
): StatusGroup[] {
  const groups: StatusGroup[] = [];
  for (const { key, metric } of items) {
    if (metric.kind === "value" || metric.kind === "loading") continue;
    const found = groups.find((group) => group.kind === metric.kind);
    if (found) found.keys.push(key);
    else groups.push({ kind: metric.kind, keys: [key] });
  }
  return groups;
}

export function noValueNext(
  groups: readonly StatusGroup[],
): "waitNew" | "seeBadge" | null {
  if (groups.some((group) => group.kind !== "none")) return "waitNew";
  return groups.length > 0 ? "seeBadge" : null;
}
