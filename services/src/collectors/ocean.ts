import type { HttpResult } from "../core/collect/http";
import type { Logger } from "../core/collect/log";
import {
  mergeReadings,
  type ObservationRow,
  type StationReadings,
} from "../core/observations/freshness";
import { parseKmaBuoy } from "../core/observations/kma-buoy";
import { parseSeaObs } from "../core/observations/sea-obs";
import type { ApiKeys } from "../core/secrets/api-keys";
import type {
  OpsStore,
  StateRecord,
  StateStore,
  StateValue,
} from "../core/store/types";
import { formatUtcIso, parseUtcIso } from "../core/warnings/time";
import { COLLECT_POLICY } from "./policy";
import { formatKst, slotStart } from "./schedule";

// collect-ocean (아키텍처 5장, 결정 기록 11장 B1·10/22 BRD-19·BRD-56)
// 파고·수온·풍속 = sea_obs(B·C 측정기), 파주기·파향 = kma_buoy. 실행 분 :10/:40
// 두 출처는 따로 처리: 한쪽이 실패해도 다른 쪽 정상값은 저장
// 마지막 정상값(readings)과 최근 시도(attempt)를 나눠 저장: 실패한 요청은 정상값·관측 시각·수신 시각을 바꾸지 않음

export const OCEAN_JOB = "collect-ocean";
// State 키. readings: 측정기·지표별 마지막 정상값 + 출처별 마지막 정상 수신 시각, attempt: 최근 시도 결과
export const OCEAN_STATE = {
  readings: { pk: "ocean", sk: "readings" },
  attempt: { pk: "ocean", sk: "attempt" },
} as const;

const BASE = "https://apihub.kma.go.kr/api/typ01/url/";
type Source = "sea_obs" | "kma_buoy";
const SOURCES: readonly Source[] = ["sea_obs", "kma_buoy"];

export interface CollectDeps {
  readonly state: StateStore;
  readonly ops: OpsStore;
  readonly keys: ApiKeys;
  readonly get: (url: string) => Promise<HttpResult>; // getText에 정책값을 묶은 함수
  readonly log: Logger;
  readonly clock: () => number; // 서버 시각(epoch ms)
  readonly owner: string; // 이 실행의 id(Lambda 요청 id)
}

// 출처 하나의 결과. ok여도 건너뛴 줄 수는 알림용으로 남김
type SourceOutcome =
  | {
      status: "ok";
      rows: ObservationRow[];
      skippedRows: number;
      receivedAt: string;
      attempts: number;
    }
  | { status: "failed"; reason: string; attempts: number };

// skipped: 다른 실행이 슬롯을 맡았거나 이미 끝남. complete: 두 출처 모두 저장. partial·failed: 다음 슬롯·재시도가 메움
export type CollectRunResult =
  | { status: "skipped"; slotId: string; claim: "done" | "busy" }
  | { status: "complete" | "partial" | "failed"; slotId: string };

interface ReadingsValue {
  readings: StationReadings;
  receivedAt: Partial<Record<Source, string>>; // 출처별 마지막 정상 수신 시각(수집 시각, 신선도 판단에 쓰지 않음)
}

async function fetchSource(
  deps: CollectDeps,
  source: Source,
  tm: string,
): Promise<SourceOutcome> {
  // 키를 읽지 못하면 호출하지 않고 이 출처의 실패로 기록(시도 기록에 남음)
  const key = await deps.keys.get("kma-apihub").catch(() => null);
  if (key === null) return { status: "failed", reason: "api_key", attempts: 0 };
  const params = new URLSearchParams({ tm, stn: "0", help: "0", authKey: key });
  const response = await deps.get(`${BASE}${source}.php?${params}`);
  if (response.status === "failed") return response;
  const receivedAt = formatUtcIso(deps.clock());
  const parsed =
    source === "sea_obs"
      ? parseSeaObs(response.body)
      : parseKmaBuoy(response.body);
  if (parsed.status === "failed") {
    return {
      status: "failed",
      reason: parsed.reason,
      attempts: response.attempts,
    };
  }
  // 자료 줄은 있는데 쓸 수 있는 행이 하나도 없음 → 형식이 바뀐 응답일 수 있어 정상으로 치지 않음
  if (parsed.rows.length === 0) {
    return {
      status: "failed",
      reason: `no_rows:skipped=${parsed.skippedRows}`,
      attempts: response.attempts,
    };
  }
  return {
    status: "ok",
    rows: parsed.rows,
    skippedRows: parsed.skippedRows,
    receivedAt,
    attempts: response.attempts,
  };
}

// 예외 사유. 원문 메시지는 주소(키)를 담을 수 있어 오류 이름만 남김
export function exceptionReason(error: unknown): string {
  return `exception:${error instanceof Error ? error.name : typeof error}`;
}

// 이전 값을 읽어 합친 뒤 씀. 읽은 recordVersion을 넘겨 사이에 다른 실행이 쓰면(conflict) 다시 읽어 한 번 더 합침
// build: 이전 기록 → 쓸 값·순서 기준(이전 orderAt에서 시작해 뒤로 가지 않음)·부르는 쪽 결과
// stale은 orderAt이 줄지 않아 정상 흐름에서는 나오지 않지만 저장소 계약상 가능한 결과라 저장 못 함으로 봄
// 로그 이름: {event}_stale(warn)·{event}_conflict(error)
async function mergeAndPut<T>(
  deps: CollectDeps,
  key: { readonly pk: string; readonly sk: string },
  event: string,
  build: (previous: StateRecord | null) => {
    value: StateValue;
    orderAt: number;
    result: T;
  },
): Promise<{ saved: boolean; result: T | null }> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const previous = await deps.state.getState(key.pk, key.sk);
    const { value, orderAt, result } = build(previous);
    const written = await deps.state.putState(
      key.pk,
      key.sk,
      value,
      orderAt,
      previous?.recordVersion ?? null,
    );
    if (written === "conflict") continue;
    if (written === "stale") deps.log("warn", `${event}_stale`, { orderAt });
    return { saved: written !== "stale", result };
  }
  deps.log("error", `${event}_conflict`);
  return { saved: false, result: null };
}

async function saveReadings(
  deps: CollectDeps,
  outcomes: Record<Source, SourceOutcome>,
): Promise<{ saved: boolean; futureRows: number }> {
  const { saved, result } = await mergeAndPut(
    deps,
    OCEAN_STATE.readings,
    "ocean_readings",
    (previous) => {
      const prevValue = (previous?.value ?? null) as ReadingsValue | null;
      const rows: ObservationRow[] = [];
      const receivedAt = { ...prevValue?.receivedAt };
      for (const source of SOURCES) {
        const outcome = outcomes[source];
        if (outcome.status !== "ok") continue;
        rows.push(...outcome.rows);
        receivedAt[source] = outcome.receivedAt;
      }
      const merged = mergeReadings(
        prevValue?.readings ?? {},
        rows,
        formatUtcIso(deps.clock()),
      );
      // 순서 기준 = 가장 늦은 관측 시각
      let orderAt = previous?.orderAt ?? 0;
      for (const station of Object.values(merged.readings)) {
        for (const reading of Object.values(station)) {
          const ms = reading ? parseUtcIso(reading.observedAt) : null;
          if (ms !== null && ms > orderAt) orderAt = ms;
        }
      }
      const value: ReadingsValue = { readings: merged.readings, receivedAt };
      return {
        value: value as unknown as StateValue,
        orderAt,
        result: merged.futureRows,
      };
    },
  );
  return { saved, futureRows: result ?? 0 };
}

export async function collectOcean(
  deps: CollectDeps,
): Promise<CollectRunResult> {
  const startedMs = deps.clock();
  const slotMs = slotStart(startedMs, COLLECT_POLICY.oceanSchedule);
  const slotId = formatKst(slotMs, "minute");
  const claim = await deps.ops.claimSlot(
    OCEAN_JOB,
    slotId,
    deps.owner,
    startedMs,
    COLLECT_POLICY.slotLeaseMs,
  );
  if (claim !== "claimed") {
    deps.log("info", "ocean_slot_skipped", { slotId, claim });
    return { status: "skipped", slotId, claim };
  }

  // 요청 시각 = 슬롯 시각(KST). 그 시각까지 공개된 최신 값을 받음
  // 각 출처의 예외는 그 출처의 실패로만 남김(한쪽이 다른 쪽을 막지 않음)
  const [seaObs, kmaBuoy] = await Promise.all(
    SOURCES.map((source) =>
      fetchSource(deps, source, slotId).catch(
        (error: unknown): SourceOutcome => ({
          status: "failed",
          reason: exceptionReason(error),
          attempts: 0,
        }),
      ),
    ),
  );
  const outcomes = { sea_obs: seaObs!, kma_buoy: kmaBuoy! };

  const anyOk = SOURCES.some((s) => outcomes[s].status === "ok");
  const { saved, futureRows } = anyOk
    ? await saveReadings(deps, outcomes)
    : { saved: false, futureRows: 0 };

  // 최근 시도 기록. 정상값과 따로 둬 실패가 정상값을 덮지 않게 함
  const attemptedAt = formatUtcIso(startedMs);
  const sources: Record<string, StateValue> = {};
  for (const source of SOURCES) {
    const outcome = outcomes[source];
    sources[source] =
      outcome.status === "ok"
        ? {
            status: "ok",
            receivedAt: outcome.receivedAt,
            skippedRows: outcome.skippedRows,
            attempts: outcome.attempts,
          }
        : {
            status: "failed",
            reason: outcome.reason,
            attempts: outcome.attempts,
          };
    if (outcome.status === "failed") {
      deps.log("error", "ocean_source_failed", {
        slotId,
        source,
        reason: outcome.reason,
      });
    } else if (outcome.skippedRows > 0) {
      deps.log("warn", "ocean_rows_skipped", {
        slotId,
        source,
        skippedRows: outcome.skippedRows,
      });
    }
  }
  if (futureRows > 0)
    deps.log("warn", "ocean_future_rows", { slotId, futureRows });
  await deps.state.putState(
    OCEAN_STATE.attempt.pk,
    OCEAN_STATE.attempt.sk,
    { attemptedAt, slotId, sources, futureRows, readingsSaved: saved },
    startedMs,
  );

  const allOk = SOURCES.every((s) => outcomes[s].status === "ok") && saved;
  // 모두 저장했을 때만 슬롯을 끝냄. 아니면 lease가 지난 뒤 재시도가 다시 맡을 수 있음
  if (allOk) await deps.ops.completeSlot(OCEAN_JOB, slotId, deps.owner);
  const status = allOk ? "complete" : saved ? "partial" : "failed";
  deps.log(status === "complete" ? "info" : "error", "ocean_run_finished", {
    slotId,
    status,
  });
  return { status, slotId };
}
