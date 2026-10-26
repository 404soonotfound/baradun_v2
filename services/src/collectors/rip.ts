import type { BeachId } from "@baradun/contracts";
import {
  inRipSeason,
  parseRipResponse,
  readRipReadings,
  RIP_LABELS,
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
// 코드는 상태와 상관없이 하나씩만(mapped·pending에 같은 코드가 있으면 멈춤), 연결된 해변 id도 하나씩만
// beachId가 data/beaches에 있는지는 빌드 입력(해변 목록)을 여기서 모르므로 테스트(rip.test)가 확인함
export function parseRipLedger(json: unknown): RipSource[] {
  const beaches =
    typeof json === "object" && json !== null && !Array.isArray(json)
      ? (json as { beaches?: unknown }).beaches
      : undefined;
  if (!Array.isArray(beaches)) {
    throw new RangeError("rip-current-beaches.json: beaches 목록이 없음");
  }
  const sources: RipSource[] = [];
  const allCodes = new Set<string>();
  for (const entry of beaches) {
    const { code, status, beachId } = (entry ?? {}) as Record<string, unknown>;
    if (typeof code !== "string" || !/^[A-Z]+$/.test(code)) {
      throw new RangeError(`rip-current-beaches.json: 코드 형식 오류`);
    }
    if (allCodes.has(code)) {
      throw new RangeError(`rip-current-beaches.json: 코드 중복: ${code}`);
    }
    allCodes.add(code);
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
  const ids = new Set(sources.map((s) => s.beachId));
  if (ids.size !== sources.length) {
    throw new RangeError("rip-current-beaches.json: 해변 중복");
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
    reqDate,
  );
}

// 저장값과 같거나 늦은 관측을 반영(같은 시각은 기관의 단계 정정으로 보고 덮음)
// 저장값 시각이 틀렸거나 서버 시각보다 미래면 믿지 않고 덮어씀(미래 시각 하나가 이후 갱신을 모두 막지 않게)
function shouldReplace(
  next: RipReading,
  previous: RipReading | undefined,
  nowMs: number,
): boolean {
  const prevMs = previous ? parseUtcIso(previous.observedAt) : null;
  if (prevMs === null || prevMs > nowMs) return true;
  return parseUtcIso(next.observedAt)! >= prevMs;
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

  // 이전 값에 이번 정상 관측을 더하고, 지금 대응표에 없는 해변·바뀐 코드의 이전 값은 버림
  // (연결을 풀거나 고친 해변에 이전 해수욕장 값이 남지 않게). 호출이 모두 실패해도 버리기는 함
  // 바뀐 것이 없으면 쓰지 않음. 충돌이면 다시 읽어 한 번 더 합침
  const { pk, sk } = RIP_STATE.readings;
  const fresh = new Map<BeachId, RipReading>();
  for (const [beachId, result] of results) {
    if (result.status === "ok") fresh.set(beachId, result.latest);
  }
  const mapped = new Map(deps.sources.map((src) => [src.beachId, src.code]));
  let saved = false;
  let dropped = 0;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const previous = await deps.state.getState(pk, sk);
    const beaches: Record<string, RipReading> = {};
    dropped = 0;
    for (const [beachId, reading] of Object.entries(
      readRipReadings(previous?.value ?? null),
    )) {
      if (mapped.get(beachId) === reading.code) beaches[beachId] = reading;
      else dropped += 1;
    }
    let applied = 0;
    for (const [beachId, reading] of fresh) {
      if (shouldReplace(reading, beaches[beachId], startedMs)) {
        beaches[beachId] = reading;
        applied += 1;
      }
    }
    if (applied === 0 && dropped === 0) {
      saved = true;
      break;
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
  if (saved && dropped > 0) {
    deps.log("info", "rip_readings_dropped", { slotId, dropped });
  }

  // 시즌(6~9월) 중 '자료 없음'은 결측 → 실패처럼 다룸(알림 없이 '제공 안 함'으로 바뀌지 않게). 비수기에는 정상
  const inSeason = inRipSeason(slotMs);
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
    } else if (result.status === "none" && inSeason) {
      deps.log("error", "rip_source_no_data", {
        slotId,
        beachId: source.beachId,
        code: source.code,
      });
    } else if (result.status === "ok") {
      if (result.skippedRows > 0) {
        deps.log("warn", "rip_rows_skipped", {
          slotId,
          beachId: source.beachId,
          skippedRows: result.skippedRows,
        });
      }
      // 모르는 문구는 저장하되 게시되지 않음(publisher가 null) → 수집 때 한 번만 알림(게시마다 반복하지 않음)
      if (!(RIP_LABELS as readonly string[]).includes(result.latest.label)) {
        deps.log("warn", "rip_unknown_label", {
          slotId,
          beachId: source.beachId,
          label: result.latest.label,
        });
      }
    }
  }
  // 비수기에 자료가 나오면 시즌이 시작됐을 수 있음(게시는 6~9월 관측만) → 알림용
  if (!inSeason && counts.ok > 0) {
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

  // 실패(시즌 중 자료 없음 포함)한 해변이 없고 저장까지 했을 때만 슬롯을 끝냄
  const broken = counts.failed + (inSeason ? counts.none : 0);
  const allOk = broken === 0 && saved;
  if (allOk) await deps.ops.completeSlot(RIP_JOB, slotId, deps.owner);
  const status = allOk
    ? "complete"
    : broken < deps.sources.length && saved
      ? "partial"
      : "failed";
  deps.log(status === "complete" ? "info" : "error", "rip_run_finished", {
    slotId,
    status,
    ...counts,
  });
  return { status, slotId };
}
