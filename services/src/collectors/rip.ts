import type { BeachId } from "@baradun/contracts";
import {
  inRipSeason,
  parseRipResponse,
  readRipReadings,
  type RipReading,
  type RipResponse,
} from "../core/rip/rip-current";
import type { StateValue } from "../core/store/types";
import { formatUtcIso, parseUtcIso } from "../core/warnings/time";
import {
  exceptionReason,
  type CollectDeps,
  type CollectRunResult,
} from "./ocean";
import { COLLECT_POLICY } from "./policy";
import { formatKst, slotStart } from "./schedule";

// collect-rip (아키텍처 5장, 결정 기록 D5·10장, BRD-57 2026-10-26 사용자 결정)
// 대응표(data/rip-current-beaches.json)의 연결된 해변마다 오늘(KST) 이안류 지수를 받아 마지막 관측 하나만 저장
// 시즌(6~9월, 한국 시각) 중 :12/:42, 비수기에는 하루 1회 슬롯만 호출(시즌 시작 확인용)
// 실패·자료 없음은 저장값을 덮지 않음. 더 늦은 관측일 때만 바꿈
// 정보 표시만. 분류에는 쓰지 않음(G1) → publisher가 info.ripCurrent에만 넣음

export const RIP_JOB = "collect-rip";
// readings: 해변별 마지막 정상 관측, attempt: 최근 시도 결과
export const RIP_STATE = {
  readings: { pk: "rip", sk: "readings" },
  attempt: { pk: "rip", sk: "attempt" },
} as const;

const BASE =
  "https://apis.data.go.kr/1192136/ripCurrent/GetRipCurrentApiService";
const MINUTE_MS = 60 * 1000;
const DAY_MS = 24 * 60 * MINUTE_MS;

// 대응표 항목 중 수집할 것(status mapped). 확인 대기·미등록은 부르지 않음
export interface RipSource {
  readonly code: string;
  readonly beachId: BeachId;
}

export interface RipDeps extends CollectDeps {
  readonly sources: readonly RipSource[];
}

// 대응표 → 수집 목록. Lambda 번들에 들어가는 입력이라 모양이 틀리면 빌드 문제 → 멈춤
// 같은 코드·해변이 두 번 나오면 한 해변에 다른 해수욕장 값이 섞이므로 멈춤
export function parseRipLedger(json: unknown): RipSource[] {
  const beaches =
    typeof json === "object" && json !== null && !Array.isArray(json)
      ? (json as { beaches?: unknown }).beaches
      : undefined;
  if (!Array.isArray(beaches)) {
    throw new RangeError("rip-current-beaches.json: beaches 목록이 없음");
  }
  const sources: RipSource[] = [];
  for (const entry of beaches) {
    const { code, status, beachId } = (entry ?? {}) as Record<string, unknown>;
    if (typeof code !== "string" || !/^[A-Z]+$/.test(code)) {
      throw new RangeError(`rip-current-beaches.json: 코드 형식 오류`);
    }
    if (status === "pending" || status === "unregistered") continue;
    if (
      status !== "mapped" ||
      typeof beachId !== "string" ||
      !/^b[0-9]{4}$/.test(beachId)
    ) {
      throw new RangeError(`rip-current-beaches.json: 항목 형식 오류: ${code}`);
    }
    sources.push({ code, beachId });
  }
  const codes = new Set(sources.map((s) => s.code));
  const ids = new Set(sources.map((s) => s.beachId));
  if (codes.size !== sources.length || ids.size !== sources.length) {
    throw new RangeError("rip-current-beaches.json: 코드·해변 중복");
  }
  return sources.sort((a, b) => a.beachId.localeCompare(b.beachId));
}

// 비수기에 호출하는 하루 1회 슬롯인지(UTC 분 기준)
function isOffSeasonSlot(slotMs: number): boolean {
  const minuteOfDay = Math.round((slotMs % DAY_MS) / MINUTE_MS);
  return minuteOfDay === COLLECT_POLICY.ripOffSeasonSlotUtcMinutes;
}

async function fetchOne(
  deps: RipDeps,
  key: string,
  source: RipSource,
  reqDate: string,
): Promise<RipResponse> {
  const params = new URLSearchParams({
    serviceKey: key,
    beachCode: source.code,
    reqDate,
    type: "json",
    pageNo: "1",
    numOfRows: String(COLLECT_POLICY.ripNumOfRows),
  });
  const response = await deps.get(`${BASE}?${params}`);
  if (response.status === "failed") {
    return { status: "failed", reason: response.reason };
  }
  return parseRipResponse(
    response.body,
    source.code,
    formatUtcIso(deps.clock()),
  );
}

// 저장값보다 늦은 관측만 반영. 저장값 시각이 틀렸으면 믿지 않고 덮어씀
function isNewer(next: RipReading, previous: RipReading | undefined): boolean {
  const prevMs = previous ? parseUtcIso(previous.observedAt) : null;
  return prevMs === null || parseUtcIso(next.observedAt)! > prevMs;
}

export async function collectRip(deps: RipDeps): Promise<CollectRunResult> {
  const startedMs = deps.clock();
  const slotMs = slotStart(startedMs, COLLECT_POLICY.ripSchedule);
  const slotId = formatKst(slotMs, "minute");
  // 비수기 다른 슬롯은 슬롯을 맡지도 호출하지도 않음(publisher도 깨우지 않음)
  if (!inRipSeason(slotMs) && !isOffSeasonSlot(slotMs)) {
    return { status: "skipped", slotId, claim: "off_season" };
  }
  const claim = await deps.ops.claimSlot(
    RIP_JOB,
    slotId,
    deps.owner,
    startedMs,
    COLLECT_POLICY.slotLeaseMs,
  );
  if (claim !== "claimed") {
    deps.log("info", "rip_slot_skipped", { slotId, claim });
    return { status: "skipped", slotId, claim };
  }

  // 키를 읽지 못하면 호출하지 않고 모든 해변 실패로 기록
  const key = await deps.keys.get("data-go-kr").catch(() => null);
  const reqDate = formatKst(slotMs, "day");
  const results = new Map<BeachId, RipResponse>();
  await Promise.all(
    deps.sources.map(async (source) => {
      const result: RipResponse =
        key === null
          ? { status: "failed", reason: "api_key" }
          : await fetchOne(deps, key, source, reqDate).catch(
              (error: unknown): RipResponse => ({
                status: "failed",
                reason: exceptionReason(error),
              }),
            );
      results.set(source.beachId, result);
    }),
  );

  // 이전 값에 이번 정상 관측만 더함. 충돌이면 다시 읽어 한 번 더 합침
  const { pk, sk } = RIP_STATE.readings;
  const fresh = new Map<BeachId, RipReading>();
  for (const [beachId, result] of results) {
    if (result.status === "ok") fresh.set(beachId, result.latest);
  }
  let saved = fresh.size === 0;
  for (let attempt = 0; attempt < 2 && fresh.size > 0; attempt += 1) {
    const previous = await deps.state.getState(pk, sk);
    const beaches: Record<string, RipReading> = readRipReadings(
      previous?.value ?? null,
    );
    for (const [beachId, reading] of fresh) {
      if (isNewer(reading, beaches[beachId])) beaches[beachId] = reading;
    }
    const written = await deps.state.putState(
      pk,
      sk,
      { beaches } as unknown as StateValue,
      Math.max(startedMs, previous?.orderAt ?? 0),
      previous?.recordVersion ?? null,
    );
    if (written === "conflict") continue;
    saved = written !== "stale";
    break;
  }
  if (!saved) deps.log("error", "rip_readings_not_saved", { slotId });

  const counts = { ok: 0, none: 0, failed: 0 };
  const sources: Record<string, StateValue> = {};
  for (const source of deps.sources) {
    const result = results.get(source.beachId)!;
    counts[result.status] += 1;
    sources[source.beachId] =
      result.status === "failed"
        ? { status: "failed", reason: result.reason }
        : result.status === "ok"
          ? {
              status: "ok",
              observedAt: result.latest.observedAt,
              skippedRows: result.skippedRows,
            }
          : { status: "none" };
    if (result.status === "failed") {
      deps.log("error", "rip_source_failed", {
        slotId,
        beachId: source.beachId,
        code: source.code,
        reason: result.reason,
      });
    } else if (result.status === "ok" && result.skippedRows > 0) {
      deps.log("warn", "rip_rows_skipped", {
        slotId,
        beachId: source.beachId,
        skippedRows: result.skippedRows,
      });
    }
  }
  // 비수기에 자료가 나오면 시즌이 시작됐을 수 있음(게시는 6~9월 관측만) → 알림용
  if (!inRipSeason(slotMs) && counts.ok > 0) {
    deps.log("warn", "rip_off_season_data", { slotId, ok: counts.ok });
  }
  await deps.state.putState(
    RIP_STATE.attempt.pk,
    RIP_STATE.attempt.sk,
    {
      attemptedAt: formatUtcIso(startedMs),
      slotId,
      keyLoaded: key !== null,
      saved,
      counts,
      sources,
    },
    startedMs,
  );

  // 실패한 해변이 없고 저장까지 했을 때만 슬롯을 끝냄
  const allOk = counts.failed === 0 && saved;
  if (allOk) await deps.ops.completeSlot(RIP_JOB, slotId, deps.owner);
  const status = allOk
    ? "complete"
    : counts.failed < deps.sources.length && saved
      ? "partial"
      : "failed";
  deps.log(status === "complete" ? "info" : "error", "rip_run_finished", {
    slotId,
    status,
    ...counts,
  });
  return { status, slotId };
}
