import type { BeachStatus, Reason, WarningItem } from "@baradun/contracts";
import {
  isWaveHeightDelayed,
  type BeachMetrics,
} from "../core/observations/beach-metrics";
import {
  byLevelThenTime,
  type BeachWarning,
} from "../core/warnings/beach-warnings";
import { WARNING_POLICY } from "../core/warnings/policy";
import { formatUtcIso, parseUtcIso } from "../core/warnings/time";
import type { TsunamiBeach } from "../core/warnings/tsunami-match";

// 해변 분류 (아키텍처 2.1·6.3, 화면 설계서 5장, 결정 기록 11장 B3·B4·10/17·10/20 ⑥)
// 게시할 때 한 번 계산함. 화면은 다시 계산하지 않고 reasons 첫 사유를 배지로 씀
// 위에서부터 먼저 맞는 것 하나: ① 5종 특보 발효 → 이용불가 ② 특보 확인 못 함 → 판단불가
// ③ 파고 관측 지연(90분 초과) → 판단불가 ④ 그 외 → 특보 없음(안전하다는 뜻 아님)

const SOURCE = "기상청"; // 특보·관측 기관(결정 기록 11장 10/20 ④)

export interface ClassifyInput {
  readonly warnings: BeachWarning; // getPwnCd 해변 결과(judgeBeachWarnings)
  readonly tsunami: TsunamiBeach; // getTsunamiMsg 해변 결과(judgeTsunamiBeaches)
  // 못 읽은 지진해일 지역 글이 하나라도 있음 → 전국 확인 못 함(10/20 ⑥). 발효 특보가 있는 해변은 이용불가 유지
  readonly tsunamiUnreadable: boolean;
  readonly metrics: BeachMetrics; // buildBeachMetrics 결과
  readonly seaZoneName: string; // 특보 확인 못 함 사유의 범위. 해변 앞바다 구역 이름
  readonly waveStationName: string | null; // 관측 지연 사유의 범위. 파고 측정소 이름(없으면 null)
  // 출처별 정상 전체 조회를 마친 서버 시각. 둘 다 있어야 확인된 것으로 봄(10/22 사용자 결정)
  readonly lastConfirmedAt: {
    readonly pwn: string | null;
    readonly tsunami: string | null;
  };
  readonly now: string;
}

export type ClassifiedBeach = Omit<BeachStatus, "info">;

// 두 출처 중 이른 확인 시각. 하나라도 확인 못 했으면 null(확인된 시각이 없음)
function earliest(a: string | null, b: string | null): string | null {
  if (a === null || b === null) return null;
  const aMs = parseUtcIso(a);
  const bMs = parseUtcIso(b);
  if (aMs === null || bMs === null) return null;
  return aMs <= bMs ? a : b;
}

export function classifyBeach(input: ClassifyInput): ClassifiedBeach {
  const { warnings, tsunami, metrics, now } = input;
  const nowMs = parseUtcIso(now);
  if (nowMs === null) throw new RangeError(`기준 시각 형식 오류: ${now}`);

  // 발효 중인 5종(getPwnCd + 지진해일). 단계 높은 순 → 같은 단계는 발표 이른 순(6.3)
  const items: WarningItem[] = [...warnings.items, ...tsunami.items].sort(
    byLevelThenTime,
  );
  const unknown =
    warnings.reasons.length > 0 ||
    tsunami.reasons.length > 0 ||
    input.tsunamiUnreadable;
  const waveDelayed = isWaveHeightDelayed(metrics);

  const confirmedAt = earliest(
    input.lastConfirmedAt.pwn,
    input.lastConfirmedAt.tsunami,
  );
  // 화면 'HH:MM 확인' 표시용. 한쪽만 확인됐으면 그 시각(다른 쪽은 이미 확인 못 함 사유로 남음)
  const shownConfirmedAt =
    confirmedAt ?? input.lastConfirmedAt.pwn ?? input.lastConfirmedAt.tsunami;

  const warningState =
    items.length > 0 ? "active" : unknown ? "unknown" : "none";
  // 계약: active·none은 lastConfirmedAt 필수. 확인 시각 없이 발효 특보만 있는 건 수집 기록이 어긋난 것 → 게시를 멈춤
  if (warningState === "active" && shownConfirmedAt === null) {
    throw new RangeError("발효 특보가 있는데 특보 확인 시각이 없음");
  }

  const warningReasons: Reason[] = items.map((item) => ({
    code: "warning",
    type: item.type,
    level: item.level,
    scope: item.zoneName,
    source: SOURCE,
    at: item.publishedAt,
  }));
  const unknownReason: Reason = {
    code: "warning_unknown",
    scope: input.seaZoneName,
    source: SOURCE,
    at: shownConfirmedAt,
  };
  const delayedReason: Reason = {
    code: "observation_delayed",
    // 지연은 측정소가 있을 때만 생김(none은 지연 아님). 이름이 없으면 구역 이름으로 범위를 남김
    scope: input.waveStationName ?? input.seaZoneName,
    source: SOURCE,
    at: metrics.waveHeight.observedAt,
  };

  // 이용불가는 특보 사유만(실패한 출처는 '확인한 것'에만, 규칙 1). 판단불가는 확인 못 함 → 관측 지연 순(6.3)
  let category: BeachStatus["category"];
  let reasons: Reason[];
  if (warningState === "active") {
    category = "unavailable";
    reasons = warningReasons;
  } else if (unknown) {
    category = "undetermined";
    reasons = waveDelayed ? [unknownReason, delayedReason] : [unknownReason];
  } else if (waveDelayed) {
    category = "undetermined";
    reasons = [delayedReason];
  } else {
    category = "clear";
    reasons = [];
  }

  return {
    category,
    reasons,
    warning: {
      state: warningState,
      items,
      source: SOURCE,
      lastConfirmedAt: shownConfirmedAt,
    },
    control: { state: "not_provided" }, // 출시는 통제를 판단하지 않음(G2)
    observation: { metrics },
    validUntil: validUntil(confirmedAt, metrics, nowMs),
  };
}

// min(파고 관측 + 90분, 특보 확인 + 45분) (B4). 파고가 fresh가 아니면(지연·측정소 없음) 특보 확인 + 45분만(10/17, 10/22)
// 두 출처 중 하나라도 확인된 적이 없으면 게시 시각 → 화면이 바로 만료로 보고 다시 받음(10/22 사용자 결정)
function validUntil(
  confirmedAt: string | null,
  metrics: BeachMetrics,
  nowMs: number,
): string {
  const confirmedMs = confirmedAt === null ? null : parseUtcIso(confirmedAt);
  if (confirmedMs === null) return formatUtcIso(nowMs);
  let untilMs =
    Math.floor((confirmedMs + WARNING_POLICY.confirmationTtlMs) / 1000) * 1000;
  const wave = metrics.waveHeight;
  const waveExpiresMs =
    wave.state === "fresh" && wave.expiresAt !== null
      ? parseUtcIso(wave.expiresAt)
      : null;
  if (waveExpiresMs !== null) untilMs = Math.min(untilMs, waveExpiresMs);
  return formatUtcIso(untilMs);
}
