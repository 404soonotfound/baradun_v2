import { CATALOG_STATE, type PhotoRecord } from "../collectors/catalog";
import { OCEAN_STATE } from "../collectors/ocean";
import { COLLECT_POLICY } from "../collectors/policy";
import { WARNINGS_STATE } from "../collectors/warnings";
import type { StationReadings } from "../core/observations/freshness";
import {
  readWaveHistory,
  type WaveHistory,
} from "../core/observations/wave-history";
import type { StateStore, StateValue } from "../core/store/types";
import { unpackItems } from "../core/warnings/archive";
import {
  normalizePwnCdResponse,
  type PwnCdResult,
} from "../core/warnings/pwncd-response";
import {
  normalizeTsunamiResponse,
  type TsunamiResult,
} from "../core/warnings/tsunami";

// State 묶음 조회 → 게시 입력 (아키텍처 6.2, 결정 기록 11장 BRD-56 ④⑤)
// 수집기가 남긴 원본 행을 풀어 기존 정규화를 그대로 다시 씀(규칙이 바뀌어도 다시 계산할 수 있게)
// 없거나 깨진 기록은 실패로 둠. 빈 목록·'특보 없음'으로 바꾸지 않고, 확인 시각도 믿지 않음(null)

export interface WarningInput<R> {
  readonly result: R;
  // 그 출처의 마지막 정상 전체 조회 시각. 원본을 못 읽었으면 null(확인 못 함)
  readonly lastConfirmedAt: string | null;
}

export interface PublishInputs {
  readonly pwncd: WarningInput<PwnCdResult>;
  readonly tsunami: WarningInput<TsunamiResult>;
  readonly readings: StationReadings;
  // 측정기별 최근 24시간 파고 원래 측정값(BRD-94). 없거나 깨진 기록은 빈 값 → 모든 점 v: null
  readonly waveHistory: WaveHistory;
  // collect-catalog의 사진 확인 결과(해변 id → 기록). 기록·확인이 없는 해변은 칸이 없음
  readonly photoChecks: Readonly<Record<string, PhotoRecord>>;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// 저장한 행 배열을 응답 모양으로 감쌈 → 수집 때와 같은 정규화 함수를 씀
const asResponse = (items: unknown[]) => ({
  response: { header: { resultCode: "00" }, body: { items: { item: items } } },
});

type Unpacked =
  | { status: "ok"; items: unknown[]; lastConfirmedAt: string }
  | { status: "failed"; reason: string };

function unpackWarnings(value: StateValue | undefined): Unpacked {
  if (value === undefined) return { status: "failed", reason: "state:missing" };
  if (
    !isObject(value) ||
    typeof value.archive !== "string" ||
    typeof value.lastConfirmedAt !== "string"
  ) {
    return { status: "failed", reason: "state:format" };
  }
  const unpacked = unpackItems(value.archive);
  if (unpacked.status === "failed") {
    return { status: "failed", reason: `archive:${unpacked.reason}` };
  }
  return {
    status: "ok",
    items: unpacked.items,
    lastConfirmedAt: value.lastConfirmedAt,
  };
}

function pwncdInput(value: StateValue | undefined): WarningInput<PwnCdResult> {
  const unpacked = unpackWarnings(value);
  if (unpacked.status === "failed") {
    return { result: unpacked, lastConfirmedAt: null };
  }
  // 수집기는 정상 응답만 저장함. 0행은 저장하지 않으므로 여기서도 실패(empty)로 읽힘
  const result = normalizePwnCdResponse(
    asResponse(unpacked.items),
    COLLECT_POLICY.pwncdNumOfRows,
  );
  return {
    result,
    lastConfirmedAt:
      result.status === "failed" ? null : unpacked.lastConfirmedAt,
  };
}

function tsunamiInput(
  value: StateValue | undefined,
): WarningInput<TsunamiResult> {
  const unpacked = unpackWarnings(value);
  if (unpacked.status === "failed") {
    return { result: unpacked, lastConfirmedAt: null };
  }
  // 빈 행 묶음 = 수집 때 03(발표 없음 확인)을 받은 것(collectors/warnings.ts)
  const result: TsunamiResult =
    unpacked.items.length === 0
      ? { status: "none" }
      : normalizeTsunamiResponse(
          asResponse(unpacked.items),
          COLLECT_POLICY.tsunamiNumOfRows,
        );
  return {
    result,
    lastConfirmedAt:
      result.status === "failed" ? null : unpacked.lastConfirmedAt,
  };
}

// 관측 기록이 없거나 모양이 다르면 빈 값 → 배정된 측정소는 관측 지연(buildBeachMetrics)
// 측정값 하나하나의 모양이 틀리면 계약 검증에서 걸려 게시를 멈춤
function readingsInput(value: StateValue | undefined): StationReadings {
  if (!isObject(value) || !isObject(value.readings)) return {};
  return value.readings as unknown as StationReadings;
}

// 사진 확인 기록(BRD-58). 수집 때 검증한 사진을 다시 보는 것이라, 기록이 없거나 모양이 다르면
// 판정 없음으로 둠(사진 유지). 특보·관측과 달리 판단·안전 정보가 아니고 원본은 저장소에서 사람이 검증함
function photoChecksInput(
  value: StateValue | undefined,
): Record<string, PhotoRecord> {
  if (!isObject(value) || !isObject(value.beaches)) return {};
  const checks: Record<string, PhotoRecord> = {};
  for (const [beachId, record] of Object.entries(value.beaches)) {
    if (!isObject(record)) continue;
    const { status, url, checkedAt } = record;
    if (
      (status === "type1" || status === "not_type1" || status === "missing") &&
      typeof url === "string" &&
      typeof checkedAt === "string"
    ) {
      checks[beachId] = { status, url, checkedAt };
    }
  }
  return checks;
}

export async function readPublishInputs(
  state: StateStore,
): Promise<PublishInputs> {
  const [pwncd, tsunami, ocean, history, catalog] = await Promise.all([
    state.getState(WARNINGS_STATE.pwncd.pk, WARNINGS_STATE.pwncd.sk),
    state.getState(WARNINGS_STATE.tsunami.pk, WARNINGS_STATE.tsunami.sk),
    state.getState(OCEAN_STATE.readings.pk, OCEAN_STATE.readings.sk),
    state.getState(OCEAN_STATE.history.pk, OCEAN_STATE.history.sk),
    state.getState(CATALOG_STATE.photos.pk, CATALOG_STATE.photos.sk),
  ]);
  return {
    pwncd: pwncdInput(pwncd?.value),
    tsunami: tsunamiInput(tsunami?.value),
    readings: readingsInput(ocean?.value),
    waveHistory: readWaveHistory(history?.value ?? null),
    photoChecks: photoChecksInput(catalog?.value),
  };
}
