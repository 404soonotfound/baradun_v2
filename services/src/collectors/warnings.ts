import type { StateValue } from "../core/store/types";
import { packItems } from "../core/warnings/archive";
import { responseItems } from "../core/warnings/response-items";
import { normalizePwnCdResponse } from "../core/warnings/pwncd-response";
import { formatUtcIso } from "../core/warnings/time";
import { normalizeTsunamiResponse } from "../core/warnings/tsunami";
import {
  exceptionReason,
  type CollectDeps,
  type CollectRunResult,
} from "./ocean";
import { COLLECT_POLICY } from "./policy";
import { formatKst, kstDaysBefore, slotStart } from "./schedule";

// collect-warnings (아키텍처 4·5장, 결정 기록 11장 B1·10/20 ⑥·10/22 BRD-18·BRD-56)
// getPwnCd와 getTsunamiMsg를 15분마다(:03/:18/:33/:48) 각각 확인함(10/22 사용자 결정)
// 확인 결과마다 45분 유효시간을 적용하는 것은 분류 쪽(checkConfirmation)
// 두 출처는 따로 처리: 각자 정상 전체 조회를 마쳤을 때만 그 출처의 lastConfirmedAt을 바꿈. 한쪽 실패가 다른 쪽 저장을 막지 않음

export const WARNINGS_JOB = "collect-warnings";
// State 키. pwncd·tsunami: 마지막 정상 조회의 원본 행(gzip·base64)과 확인 시각, attempt: 최근 시도 결과
export const WARNINGS_STATE = {
  pwncd: { pk: "warnings", sk: "pwncd" },
  tsunami: { pk: "warnings", sk: "tsunami" },
  attempt: { pk: "warnings", sk: "attempt" },
} as const;

const PWNCD_URL = "https://apis.data.go.kr/1360000/WthrWrnInfoService/getPwnCd";
const TSUNAMI_URL =
  "https://apis.data.go.kr/1360000/EqkInfoService/getTsunamiMsg";
type Source = "pwncd" | "tsunami";
const SOURCES: readonly Source[] = ["pwncd", "tsunami"];

type SourceOutcome =
  | { status: "ok"; confirmedAt: string; rowCount: number; attempts: number }
  | { status: "failed"; reason: string; attempts: number };

function requestUrl(
  base: string,
  key: string,
  numOfRows: number,
  from: string,
  to: string,
) {
  const params = new URLSearchParams({
    ServiceKey: key,
    pageNo: "1",
    numOfRows: String(numOfRows),
    dataType: "JSON",
    fromTmFc: from,
    toTmFc: to,
  });
  return `${base}?${params}`;
}

async function collectSource(
  deps: CollectDeps,
  source: Source,
  nowMs: number,
): Promise<SourceOutcome> {
  // 키를 읽지 못하면 호출하지 않고 이 출처의 실패로 기록(시도 기록에 남음)
  const key = await deps.keys.get("data-go-kr").catch(() => null);
  if (key === null) return { status: "failed", reason: "api_key", attempts: 0 };
  const today = formatKst(nowMs, "day");
  const numOfRows =
    source === "pwncd"
      ? COLLECT_POLICY.pwncdNumOfRows
      : COLLECT_POLICY.tsunamiNumOfRows;
  const lookback =
    source === "pwncd"
      ? COLLECT_POLICY.pwncdLookbackDays
      : COLLECT_POLICY.tsunamiLookbackDays;
  const url = requestUrl(
    source === "pwncd" ? PWNCD_URL : TSUNAMI_URL,
    key,
    numOfRows,
    kstDaysBefore(nowMs, lookback),
    today,
  );
  const response = await deps.get(url);
  if (response.status === "failed") return response;
  // 정상 전체 조회를 마친 서버 시각(10/22 BRD-18 ②)
  const confirmedAt = formatUtcIso(deps.clock());
  const { attempts } = response;

  let json: unknown;
  try {
    json = JSON.parse(response.body);
  } catch {
    return { status: "failed", reason: "format:json", attempts };
  }

  let items: unknown[];
  let rowCount: number;
  if (source === "pwncd") {
    const result = normalizePwnCdResponse(json, numOfRows);
    if (result.status === "failed") return { ...result, attempts };
    items = responseItems(json) ?? []; // 정상 판정을 통과해 목록이 있음
    rowCount = result.rowCount;
  } else {
    const result = normalizeTsunamiResponse(json, numOfRows);
    if (result.status === "failed") return { ...result, attempts };
    // 03 = 발표 없음 확인 → 빈 행 묶음으로 저장(확인된 '없음')
    items = result.status === "none" ? [] : (responseItems(json) ?? []);
    rowCount = items.length;
  }

  const packed = packItems(items);
  if (packed.status === "failed") return { ...packed, attempts };
  const { pk, sk } = WARNINGS_STATE[source];
  const written = await deps.state.putState(
    pk,
    sk,
    { archive: packed.archive, rowCount, lastConfirmedAt: confirmedAt },
    Date.parse(confirmedAt),
  );
  // 늦게 끝난 옛 실행(stale)이나 동시 쓰기(conflict)는 이 실행의 확인으로 치지 않음
  if (written === "stale" || written === "conflict") {
    return { status: "failed", reason: `state:${written}`, attempts };
  }
  return { status: "ok", confirmedAt, rowCount, attempts };
}

export async function collectWarnings(
  deps: CollectDeps,
): Promise<CollectRunResult> {
  const startedMs = deps.clock();
  const slotId = formatKst(
    slotStart(startedMs, COLLECT_POLICY.warningsSchedule),
    "minute",
  );
  const claim = await deps.ops.claimSlot(
    WARNINGS_JOB,
    slotId,
    deps.owner,
    startedMs,
    COLLECT_POLICY.slotLeaseMs,
  );
  if (claim !== "claimed") {
    deps.log("info", "warnings_slot_skipped", { slotId, claim });
    return { status: "skipped", slotId, claim };
  }

  // 각 출처의 예외는 그 출처의 실패로만 남김(한쪽이 다른 쪽을 막지 않음)
  const settle = (source: Source) =>
    collectSource(deps, source, startedMs).catch(
      (error: unknown): SourceOutcome => ({
        status: "failed",
        reason: exceptionReason(error),
        attempts: 0,
      }),
    );
  const [pwncd, tsunami] = await Promise.all([
    settle("pwncd"),
    settle("tsunami"),
  ]);
  const outcomes: Record<Source, SourceOutcome> = { pwncd, tsunami };

  const sources: Record<string, StateValue> = {};
  for (const source of SOURCES) {
    const outcome = outcomes[source];
    sources[source] = { ...outcome };
    if (outcome.status === "failed") {
      deps.log("error", "warnings_source_failed", {
        slotId,
        source,
        reason: outcome.reason,
      });
    }
  }
  // 잘리면 전국 '특보 확인 못 함'이 되므로 상한의 70%를 넘으면 미리 알림(10/22 BRD-18)
  if (
    outcomes.pwncd.status === "ok" &&
    outcomes.pwncd.rowCount >
      COLLECT_POLICY.pwncdNumOfRows * COLLECT_POLICY.pwncdRowAlertRatio
  ) {
    deps.log("warn", "pwncd_rows_near_limit", {
      slotId,
      rowCount: outcomes.pwncd.rowCount,
      numOfRows: COLLECT_POLICY.pwncdNumOfRows,
    });
  }
  await deps.state.putState(
    WARNINGS_STATE.attempt.pk,
    WARNINGS_STATE.attempt.sk,
    { attemptedAt: formatUtcIso(startedMs), slotId, sources },
    startedMs,
  );

  const okCount = SOURCES.filter((s) => outcomes[s].status === "ok").length;
  const status =
    okCount === 2 ? "complete" : okCount === 1 ? "partial" : "failed";
  if (status === "complete") {
    await deps.ops.completeSlot(WARNINGS_JOB, slotId, deps.owner);
  }
  deps.log(status === "complete" ? "info" : "error", "warnings_run_finished", {
    slotId,
    status,
  });
  return { status, slotId };
}
