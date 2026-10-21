import type {
  BeachStatus,
  Metric,
  Reason,
  WarningLevel,
  WarningType,
} from "@baradun/contracts";

import { isExpired, type Clock } from "./clock";

// 해변 하나의 화면 상태 (아키텍처 9.1, 결정 기록 11장 B4·B5, BRD-41)
// 분류(category)는 publisher가 게시한 값을 그대로 씀(G1). 여기서 하는 일은 셋뿐:
//   1. 만료·오프라인이면 판단불가로 내림(발효 중 특보 배지는 유지, B5)
//   2. 모르는 값·빠진 값은 판단불가로(위험 정보는 사라지지 않음)
//   3. 지표별 만료가 지난 값만 숨김(분류는 그대로, B4)

export type Category = BeachStatus["category"];
export type MetricKey = keyof BeachStatus["observation"]["metrics"];

export const METRIC_KEYS = [
  "waveHeight",
  "wavePeriod",
  "waveDirection",
  "waterTemp",
  "wind",
] as const satisfies readonly MetricKey[];

const CATEGORIES = ["clear", "unavailable", "undetermined"] as const;
const WARNING_TYPES = [
  "wind_wave",
  "strong_wind",
  "typhoon",
  "storm_surge",
  "tsunami",
] as const satisfies readonly WarningType[];
const WARNING_LEVELS = [
  "advisory",
  "warning",
  "severe_warning",
] as const satisfies readonly WarningLevel[];

// 배지에 쓸 사유. 문구는 use-badge-text.ts가 문구 키로 바꿈
export type BadgeLabel =
  | { kind: "clear" }
  | { kind: "warning"; type: WarningType; level: WarningLevel }
  | { kind: "warning_unknown" }
  | { kind: "observation_delayed" }
  // 모르는 사유 code: 서버 분류는 유지하고 이름만 일반 단어(9.1)
  | { kind: "restricted" } // 이용불가 → "이용 제한"
  | { kind: "unconfirmed" }; // 판단불가 → "확인 못 함" (데이터 없음·지원 밖 형식 포함)

export type MetricView =
  | { kind: "value"; value: number; unit: Metric["unit"]; observedAt: string }
  | { kind: "none" } // 20km 안 측정기 없음 → '가까운 관측 없음'
  | { kind: "hidden" }; // 지연·만료·결측 → 값 자리 비움

export type BeachView =
  | { kind: "hidden" } // 노출 끔(hidden: true)일 때만
  | { kind: "loading" } // 아직 한 번도 받지 못함
  | {
      kind: "ready";
      category: Category;
      // 배지 맨 앞 글자(첫 사유). 나머지 사유는 reasons
      badge: BadgeLabel;
      reasons: BadgeLabel[];
      // B5: 새 정보를 못 받는 동안 유지하는 발효 특보의 마지막 확인 시각 → "HH:MM 확인 · 이후 확인 못 함"
      confirmedAt: string | null;
      metrics: Record<MetricKey, MetricView>;
    };

// 화면 전체 데이터 상태 중 해변 계산에 필요한 부분 (store.ts의 SnapshotState와 같은 모양)
export interface ViewSource {
  phase: "loading" | "ready" | "maintenance" | "schema_unsupported";
  statuses: Record<string, unknown> | null;
  // 마지막 조회가 성공했는지. false = 오프라인·장애(B5)
  live: boolean;
  clock: Clock;
  // 보정된 지금 시각(ms)
  nowMs: number;
}

const HIDDEN_METRICS = Object.fromEntries(
  METRIC_KEYS.map((key) => [key, { kind: "hidden" }]),
) as Record<MetricKey, MetricView>;

const UNDETERMINED: BeachView = {
  kind: "ready",
  category: "undetermined",
  badge: { kind: "unconfirmed" },
  reasons: [{ kind: "unconfirmed" }],
  confirmedAt: null,
  metrics: HIDDEN_METRICS,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function includes<T>(list: readonly T[], value: unknown): value is T {
  return (list as readonly unknown[]).includes(value);
}

function reasonLabel(reason: Partial<Reason>, category: Category): BadgeLabel {
  switch (reason.code) {
    case "warning":
      // 종류·단계를 모르면 이름을 지어내지 않고 일반 단어로
      if (
        includes(WARNING_TYPES, reason.type) &&
        includes(WARNING_LEVELS, reason.level)
      ) {
        return { kind: "warning", type: reason.type, level: reason.level };
      }
      break;
    case "warning_unknown":
      return { kind: "warning_unknown" };
    case "observation_delayed":
      return { kind: "observation_delayed" };
  }
  return genericLabel(category);
}

function genericLabel(category: Category): BadgeLabel {
  if (category === "unavailable") return { kind: "restricted" };
  if (category === "undetermined") return { kind: "unconfirmed" };
  return { kind: "clear" };
}

// 사유 목록은 항상 하나 이상(배지 맨 앞 글자가 비지 않게). 사유가 없으면 분류에 맞는 일반 단어
function reasonLabels(
  reasons: unknown,
  category: Category,
): [BadgeLabel, ...BadgeLabel[]] {
  if (category === "clear") return [{ kind: "clear" }];
  const [first, ...rest] = (Array.isArray(reasons) ? reasons : [])
    .filter(isRecord)
    .map((reason) => reasonLabel(reason, category));
  return first ? [first, ...rest] : [genericLabel(category)];
}

function metricView(metric: unknown, source: ViewSource): MetricView {
  if (!isRecord(metric)) return { kind: "hidden" };
  if (metric.state === "none") return { kind: "none" };
  if (
    metric.state === "fresh" &&
    typeof metric.value === "number" &&
    typeof metric.observedAt === "string" &&
    typeof metric.unit === "string" &&
    !isExpired(metric.expiresAt as string | null, source.nowMs, source.clock)
  ) {
    return {
      kind: "value",
      value: metric.value,
      unit: metric.unit as Metric["unit"],
      observedAt: metric.observedAt,
    };
  }
  // delayed, 지표별 expiresAt 지남, 모르는 state → 그 값만 숨김(분류에 영향 없음, B4)
  return { kind: "hidden" };
}

export function deriveBeachView(
  beach: { id: string; hidden: boolean },
  source: ViewSource,
): BeachView {
  if (beach.hidden) return { kind: "hidden" };
  if (source.phase === "loading") return { kind: "loading" };
  // 지원 범위 밖 schemaVersion → 모든 해변 판단불가(배너는 화면에서, 9.1)
  if (source.phase === "schema_unsupported") return UNDETERMINED;

  // status에 없는 해변 → 판단불가(숨기지 않음, 9장)
  const status = source.statuses?.[beach.id];
  if (!isRecord(status) || !includes(CATEGORIES, status.category)) {
    return UNDETERMINED;
  }

  const observation = isRecord(status.observation) ? status.observation : {};
  const rawMetrics = isRecord(observation.metrics) ? observation.metrics : {};
  const metrics = Object.fromEntries(
    METRIC_KEYS.map((key) => [key, metricView(rawMetrics[key], source)]),
  ) as Record<MetricKey, MetricView>;

  const category = status.category;
  const expired = isExpired(
    status.validUntil as string | null,
    source.nowMs,
    source.clock,
  );

  if (source.live && !expired) {
    const reasons = reasonLabels(status.reasons, category);
    return {
      kind: "ready",
      category,
      badge: reasons[0],
      reasons,
      confirmedAt: null,
      metrics,
    };
  }

  // 만료·오프라인·장애(B5). 마지막에 이용불가였으면 배지를 그대로 두고 마지막 확인 시각을 붙임
  if (category === "unavailable") {
    const reasons = reasonLabels(status.reasons, category);
    const warning = isRecord(status.warning) ? status.warning : {};
    return {
      kind: "ready",
      category,
      badge: reasons[0],
      reasons,
      confirmedAt:
        typeof warning.lastConfirmedAt === "string"
          ? warning.lastConfirmedAt
          : null,
      metrics,
    };
  }
  // 그 외('특보 없음'이던 해변 포함)는 특보 확인 못 함
  return {
    kind: "ready",
    category: "undetermined",
    badge: { kind: "warning_unknown" },
    reasons: [{ kind: "warning_unknown" }],
    confirmedAt: null,
    metrics,
  };
}
