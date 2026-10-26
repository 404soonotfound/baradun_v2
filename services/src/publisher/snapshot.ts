import type {
  Beach,
  BeachesFile,
  BeachId,
  BeachStatus,
  HistoryFile,
  NationwideWarningsFile,
  StatusFile,
  WarningItem,
} from "@baradun/contracts";
import { buildBeachMetrics } from "../core/observations/beach-metrics";
import { parseNow } from "../core/observations/freshness";
import {
  historyFrame,
  historyPoints,
  type WaveHistory,
} from "../core/observations/wave-history";
import { ripCurrentInfo } from "../core/rip/rip-current";
import {
  byLevelThenTime,
  judgeBeachWarnings,
  type ZoneTables,
} from "../core/warnings/beach-warnings";
import { checkConfirmation } from "../core/warnings/confirmation";
import type { PwnEvent } from "../core/warnings/normalize";
import { parseUtcIso } from "../core/warnings/time";
import { judgeTsunamiBeaches } from "../core/warnings/tsunami-match";
import { classifyBeach } from "./classify";
import type { PublishInputs } from "./inputs";
import { seasonInfo, type SeasonTable } from "./season";

// 게시 파일 네 개 조립 (아키텍처 6.2·6.3, 결정 기록 11장 B2·B3·B4, BRD-61)
// 시각을 인자로 받는 순수 함수. 저장소·시계를 직접 읽지 않음
// 숨긴 해변(hidden)도 beaches·status에 넣음. 숨기는 일은 화면이 함(2026-10-23 사용자 결정)

export interface SnapshotInput {
  readonly beaches: readonly Beach[];
  readonly zones: ZoneTables;
  readonly inputs: PublishInputs;
  readonly seasons: SeasonTable; // data/beach-meta.json의 운영 기간
  readonly now: string; // 서버 시각(UTC ISO)
}

export interface Snapshot {
  readonly beaches: BeachesFile;
  readonly status: StatusFile;
  readonly history: HistoryFile;
  readonly nationwideWarnings: NationwideWarningsFile;
}

// 해변 하나의 분류가 멈춘 경우. 로그에 id와 slug를 함께 남김(아키텍처 9장)
export class BeachSnapshotError extends Error {
  constructor(
    readonly beachId: BeachId,
    readonly slug: string,
    cause: unknown,
  ) {
    super(
      `해변 분류 중단: ${beachId}(${slug}): ${cause instanceof Error ? cause.message : String(cause)}`,
    );
    this.name = "BeachSnapshotError";
  }
}

export function buildSnapshot(input: SnapshotInput): Snapshot {
  const { zones, inputs, now } = input;
  parseNow(now); // 형식이 틀리면 멈춤(freshness.ts와 같은 기준)
  const beaches = [...input.beaches].sort((a, b) => a.id.localeCompare(b.id));
  // 같은 id가 둘이면 한 해변 상태가 다른 해변 값으로 덮임 → 게시를 멈춤
  for (let i = 1; i < beaches.length; i += 1) {
    if (beaches[i]!.id === beaches[i - 1]!.id) {
      throw new RangeError(`해변 id 중복: ${beaches[i]!.id}`);
    }
  }

  const pwnEvents =
    inputs.pwncd.result.status === "ok" ? inputs.pwncd.result.events : [];
  const warnings = judgeBeachWarnings({
    events: pwnEvents,
    now,
    lastConfirmedAt: inputs.pwncd.lastConfirmedAt,
    beaches,
    zones,
  });
  const tsunami = judgeTsunamiBeaches({
    result: inputs.tsunami.result,
    now,
    lastConfirmedAt: inputs.tsunami.lastConfirmedAt,
    beaches,
  });
  const tsunamiUnreadable = tsunami.unreadable.length > 0;

  const status: Record<BeachId, BeachStatus> = {};
  for (const beach of beaches) {
    const warning = warnings.beaches[beach.id]!;
    try {
      const classified = classifyBeach({
        warnings: warning,
        tsunami: tsunami.beaches[beach.id]!,
        tsunamiUnreadable,
        metrics: buildBeachMetrics(beach.stations, inputs.readings, now),
        // 구역표에 없는 코드는 이미 판단불가 사유(zone_unverified). 범위 글자는 코드 그대로 둠
        seaZoneName:
          zones.sea[beach.warningZones.sea] ?? beach.warningZones.sea,
        waveStationName: beach.stations.waveHeight?.name.ko ?? null,
        lastConfirmedAt: {
          pwn: inputs.pwncd.lastConfirmedAt,
          tsunami: inputs.tsunami.lastConfirmedAt,
        },
        now,
      });
      status[beach.id] = {
        ...classified,
        info: {
          season: seasonInfo(input.seasons, beach.id, now), // 정보 배지만(분류에 쓰지 않음)
          // 이안류는 정보로만(분류 입력에 넣지 않음, G1·D5). 모르는 값·시즌 밖·오래된 관측은 null(BRD-57)
          ripCurrent: ripCurrentInfo(inputs.ripReadings[beach.id], now).info,
          nearbyWarnings: warning.nearby, // 분류에 쓰지 않음(B3)
        },
      };
    } catch (error) {
      throw new BeachSnapshotError(beach.id, beach.slug, error);
    }
  }

  return {
    beaches: { beaches: beaches.map((beach) => publishedBeach(beach, inputs)) },
    status: { beaches: status },
    history: waveHistoryFile(beaches, inputs.waveHistory, now),
    nationwideWarnings: nationwide(
      input,
      pwnEvents,
      tsunami.beaches,
      tsunamiUnreadable,
    ),
  };
}

// 게시할 해변 한 곳. 마지막 사진 확인(collect-catalog)이 1유형이 아니거나 사진을 못 찾았으면
// 사진을 빼고 게시함(공공누리 1유형만 사용, 결정 기록 11장 10/21 · BRD-58). 화면은 null이면 일러스트로 대체
// 확인한 주소가 지금 사진과 다르면(확인 뒤 저장소에서 바뀜) 그 기록은 이 사진의 결과가 아님 → 사진 유지
// 기록·확인이 없는 사진도 유지(저장소에 넣을 때 사람이 1유형을 검증함)
function publishedBeach(beach: Beach, inputs: PublishInputs): Beach {
  if (beach.photo === null) return beach;
  const check = inputs.photoChecks[beach.id];
  if (
    check !== undefined &&
    check.url === beach.photo.url &&
    check.status !== "type1"
  ) {
    return { ...beach, photo: null };
  }
  return beach;
}

// 관측소별 최근 24시간 파고(1시간 간격, B2). 해변에 배정된 파고 측정소만 게시
// 점 규칙·결측 처리는 core/observations/wave-history.ts(BRD-94). 이력이 없는 측정소는 모든 점 v: null(차트 빗금)
function waveHistoryFile(
  beaches: readonly Beach[],
  history: WaveHistory,
  now: string,
): HistoryFile {
  const ids = new Set<string>();
  for (const beach of beaches) {
    const station = beach.stations.waveHeight;
    if (station) ids.add(station.id);
  }
  const frame = historyFrame(now); // 점 시각 25개는 측정소마다 같음 → 한 번만 계산
  const stations: HistoryFile["stations"] = {};
  for (const id of [...ids].sort()) {
    stations[id] = {
      unit: "m",
      points: historyPoints(history[id] ?? [], frame),
    };
  }
  return { stations };
}

// 홈 '전국 해상 특보' = 앞바다 구역(별표5)에 발효 중인 5종 + 지진해일(2026-10-23 사용자 결정)
// lastConfirmedAt: 두 출처 중 이른 확인 시각. 한쪽이라도 확인 못 했거나 읽지 못한 구역·발표가 있으면 null
// → 목록이 비어도 '특보 없음'으로 읽히지 않게 함
function nationwide(
  input: SnapshotInput,
  pwnEvents: readonly PwnEvent[],
  tsunamiBeaches: ReturnType<typeof judgeTsunamiBeaches>["beaches"],
  tsunamiUnreadable: boolean,
): NationwideWarningsFile {
  const { zones, inputs, now } = input;
  const seaZones = judgeBeachWarnings({
    events: pwnEvents,
    now,
    lastConfirmedAt: inputs.pwncd.lastConfirmedAt,
    beaches: Object.keys(zones.sea).map((code) => ({
      id: code,
      warningZones: { sea: code },
    })),
    zones,
  });

  // 지진해일은 해변마다 같은 발표가 반복됨 → 한 번만
  const tsunamiItems = new Map<string, WarningItem>();
  for (const beach of Object.values(tsunamiBeaches)) {
    for (const item of beach.items) {
      tsunamiItems.set(JSON.stringify(item), item);
    }
  }
  const items = [
    ...Object.values(seaZones.beaches).flatMap((zone) => zone.items),
    ...tsunamiItems.values(),
  ].sort(
    (a, b) => byLevelThenTime(a, b) || a.zoneName.localeCompare(b.zoneName),
  );

  const pwnCheck = checkConfirmation(inputs.pwncd.lastConfirmedAt, now);
  const tsunamiCheck = checkConfirmation(inputs.tsunami.lastConfirmedAt, now);
  const unverified =
    !pwnCheck.confirmed ||
    !tsunamiCheck.confirmed ||
    inputs.tsunami.result.status === "failed" ||
    tsunamiUnreadable ||
    // 지역은 읽었지만 종류·시각을 못 읽은 지진해일 행은 해변 사유로만 남음 → 전국도 확인 못 함
    Object.values(tsunamiBeaches).some((beach) => beach.reasons.length > 0) ||
    Object.values(seaZones.beaches).some((zone) => zone.reasons.length > 0);
  const pwnAt = inputs.pwncd.lastConfirmedAt!;
  const tsunamiAt = inputs.tsunami.lastConfirmedAt!;
  return {
    lastConfirmedAt: unverified
      ? null
      : parseUtcIso(pwnAt)! <= parseUtcIso(tsunamiAt)!
        ? pwnAt
        : tsunamiAt,
    items,
  };
}
