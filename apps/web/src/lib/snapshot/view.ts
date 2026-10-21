import type {
  BeachStatus,
  Metric,
  Reason,
  WarningLevel,
  WarningType,
} from "@baradun/contracts";

import { isExpired, isTime, type Clock } from "./clock";

// 특보 확인 유효시간 45분(아키텍처 14.3 N2), 파고 유효시간 90분(B4). '특보 없음' 근거 검증에만 씀(분류 계산 아님)
const WARNING_CONFIRM_VALID_MS = 45 * 60_000;
const WAVE_HEIGHT_VALID_MS = 90 * 60_000;

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
      // B5: 새 정보를 못 받는 중(오프라인·만료·장애). 화면에 '이후 확인 못 함'을 붙임
      stale: boolean;
      // B5: 유지하는 발효 특보의 마지막 확인 시각 → "HH:MM 확인 · 이후 확인 못 함".
      // 읽을 수 없는 시각이면 null(stale은 그대로 true라 '확인 시각 모름'으로 표시)
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
  // 보정된 지금 시각(ms). NaN = 지금 시각을 알 수 없음(기기 시계가 틀린 게 확실) → 모두 만료
  nowMs: number;
}

const HIDDEN_METRICS = Object.fromEntries(
  METRIC_KEYS.map((key) => [key, { kind: "hidden" }]),
) as Record<MetricKey, MetricView>;

const UNDETERMINED = {
  kind: "ready",
  category: "undetermined",
  badge: { kind: "unconfirmed" },
  reasons: [{ kind: "unconfirmed" }],
  stale: false,
  confirmedAt: null,
  metrics: HIDDEN_METRICS,
} satisfies BeachView;

// 지표별 단위(계약 6.3). 키와 단위가 어긋나면 값을 보여주지 않음
const METRIC_UNITS: Record<MetricKey, Metric["unit"]> = {
  waveHeight: "m",
  wavePeriod: "s",
  waveDirection: "deg",
  waterTemp: "°C",
  wind: "m/s",
};

export function isRecord(value: unknown): value is Record<string, unknown> {
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

// 값·관측 시각·단위를 읽을 수 있는 fresh 지표인지(만료는 따로 봄)
function isReadableFresh(
  metric: Record<string, unknown> | null,
  key: MetricKey,
): metric is Record<string, unknown> & { value: number; observedAt: string } {
  return (
    metric?.state === "fresh" &&
    typeof metric.value === "number" &&
    Number.isFinite(metric.value) &&
    isTime(metric.observedAt) &&
    metric.unit === METRIC_UNITS[key]
  );
}

// '특보 없음'의 근거(계약 불변식, 아키텍처 2.1·6.3): 사유 없음, 특보 state none + 출처·확인 시각,
// 파고 fresh(값을 읽을 수 있음) 또는 none. 배포 오류로 하나라도 빠지면 판단불가.
// validUntil이 근거(특보 확인 + 45분, 파고 관측 + 90분·파고 expiresAt)보다 길어도 판단불가.
// 그래서 validUntil 안이면 파고도 만료 전임(파고 자체 만료를 deriveBeachView에서 따로 보지 않음)
function isConfirmedClear(status: Record<string, unknown>): boolean {
  const warning = isRecord(status.warning) ? status.warning : null;
  const observation = isRecord(status.observation) ? status.observation : null;
  const metrics = isRecord(observation?.metrics) ? observation.metrics : null;
  const waveHeight = isRecord(metrics?.waveHeight) ? metrics.waveHeight : null;
  if (
    !Array.isArray(status.reasons) ||
    status.reasons.length !== 0 ||
    warning?.state !== "none" ||
    !Array.isArray(warning.items) ||
    warning.items.length !== 0 ||
    typeof warning.source !== "string" ||
    warning.source === "" ||
    !isTime(warning.lastConfirmedAt) ||
    !isTime(status.validUntil)
  ) {
    return false;
  }
  // 유효 시각이 근거보다 길면 모순(계약 6.3: validUntil = min(파고 observedAt + 90분, 특보 lastConfirmedAt + 45분)).
  // 오래된 특보 확인이 validUntil만 늘려 '특보 없음'으로 계속 보이지 않게
  const validUntilMs = Date.parse(status.validUntil);
  if (
    validUntilMs >
    Date.parse(warning.lastConfirmedAt) + WARNING_CONFIRM_VALID_MS
  ) {
    return false;
  }
  if (waveHeight?.state === "none") return true;
  // 파고 expiresAt만 늘린 응답도 막도록 관측 시각 + 90분과도 비교
  return (
    isReadableFresh(waveHeight, "waveHeight") &&
    isTime(waveHeight.expiresAt) &&
    validUntilMs <= Date.parse(waveHeight.expiresAt) &&
    validUntilMs <= Date.parse(waveHeight.observedAt) + WAVE_HEIGHT_VALID_MS
  );
}

function metricView(
  metric: unknown,
  key: MetricKey,
  source: ViewSource,
): MetricView {
  if (!isRecord(metric)) return { kind: "hidden" };
  if (metric.state === "none") return { kind: "none" };
  if (
    isReadableFresh(metric, key) &&
    !isExpired(metric.expiresAt as string | null, source.nowMs, source.clock)
  ) {
    return {
      kind: "value",
      value: metric.value,
      unit: METRIC_UNITS[key],
      observedAt: metric.observedAt,
    };
  }
  // delayed, 지표별 expiresAt 지남, 읽을 수 없는 값·시각·단위, 모르는 state → 그 값만 숨김(분류에 영향 없음, B4)
  return { kind: "hidden" };
}

export function deriveBeachView(
  beach: { id: string; hidden: boolean },
  source: ViewSource,
): BeachView {
  if (beach.hidden) return { kind: "hidden" };
  if (source.phase === "loading") return { kind: "loading" };
  // 지원 범위 밖 schemaVersion → 모든 해변 판단불가(배너는 화면에서, 9.1)
  // 점검 중: 화면이 전체를 덮고 마지막 값도 숨김(9.1). 다른 소비자가 계산해도 지난 값이 나오지 않게
  if (source.phase === "schema_unsupported" || source.phase === "maintenance") {
    return UNDETERMINED;
  }

  // 데이터가 없거나 읽을 수 없어 판단불가. 오프라인이면 '이후 확인 못 함'도 붙도록 stale 표시
  const noData: BeachView = { ...UNDETERMINED, stale: !source.live };

  // status에 없는 해변 → 판단불가(숨기지 않음, 9장)
  const status = source.statuses?.[beach.id];
  if (!isRecord(status) || !includes(CATEGORIES, status.category)) {
    return noData;
  }
  // 근거가 빠지거나 모순된 '특보 없음'은 내보내지 않음. 이용불가는 위험 정보라 그대로 둠
  if (status.category === "clear" && !isConfirmedClear(status)) {
    return noData;
  }

  const observation = isRecord(status.observation) ? status.observation : {};
  const rawMetrics = isRecord(observation.metrics) ? observation.metrics : {};
  const metrics = Object.fromEntries(
    METRIC_KEYS.map((key) => [key, metricView(rawMetrics[key], key, source)]),
  ) as Record<MetricKey, MetricView>;

  const category = status.category;
  const warning = isRecord(status.warning) ? status.warning : {};
  // B5에서 붙일 마지막 확인 시각. 읽을 수 없으면 null('확인 시각 모름')
  const confirmedAt = isTime(warning.lastConfirmedAt)
    ? warning.lastConfirmedAt
    : null;
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
      stale: false,
      confirmedAt: null,
      metrics,
    };
  }

  // 만료·오프라인·장애(B5). 마지막에 이용불가였으면 배지를 그대로 두고 마지막 확인 시각을 붙임
  if (category === "unavailable") {
    const reasons = reasonLabels(status.reasons, category);
    return {
      kind: "ready",
      category,
      badge: reasons[0],
      reasons,
      stale: true,
      confirmedAt,
      metrics,
    };
  }
  // 그 외('특보 없음'이던 해변 포함)는 특보 확인 못 함. 마지막 확인 시각을 알면 함께 보여줌
  // (알고 있는 시각을 '확인 시각 모름'으로 안내하지 않게)
  return {
    kind: "ready",
    category: "undetermined",
    badge: { kind: "warning_unknown" },
    reasons: [{ kind: "warning_unknown" }],
    stale: true,
    confirmedAt,
    metrics,
  };
}
