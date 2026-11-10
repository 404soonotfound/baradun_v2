import { RUN_RECORD_RETENTION_MS } from "./run-log";

// 게시 요약 (BRD-187, 화면 ADM-COLLECT)
// publisher가 게시에 성공할 때마다 Ops에 남김. 운영 API는 State·게시 파일 대신 이것만 읽음(G1·D16-B2)
// - 분류는 publisher가 게시할 때 한 번 계산한 그대로 옮김. 여기서 다시 판단하지 않음
// - 쓰기가 실패해도 게시는 그대로. 빠진 요약은 previous 사슬로 드러남 → 운영 화면은 '확인 못 함'
// 키: publish#summary / {게시 버전}. 버전 순 정렬 → 기간 조회(sk BETWEEN)

export const PUBLISH_SUMMARY_PK = "publish#summary";

// 수집 실행 기록과 같은 보존(7일 장애 기록 + 하루 여유)
export const PUBLISH_SUMMARY_RETENTION_MS = RUN_RECORD_RETENTION_MS;

export interface StationUse {
  readonly name: string; // 관측소 한국어 이름(해변 파일 stations.*.name.ko)
  // 이 관측소를 어느 지표로든 쓰는 해변
  readonly beachIds: readonly string[];
  // 이 관측소를 파고로 쓰는 해변. 관측 지연(파고 90분) 분류는 이 해변에만 생김
  readonly waveBeachIds: readonly string[];
}

export interface PublishSummary {
  readonly version: string;
  // 이 게시 직전에 앱에 보이던 버전. 없으면 null(첫 게시)
  readonly previous: string | null;
  readonly publishedAt: string; // UTC ISO
  readonly beachCount: number;
  // 사유에 관측 지연(observation_delayed)이 있는 해변(publisher 분류 그대로)
  readonly delayedBeachIds: readonly string[];
  readonly stations: Readonly<Record<string, StationUse>>;
}

// 계약(@baradun/contracts)의 Beach·BeachStatus 가운데 쓰는 부분만. infra 권한 테스트가 이 파일을 가져오므로
// 계약 패키지를 가져오지 않음(infra의 모듈 해석과 맞지 않음). 계약 타입은 이 모양에 그대로 들어맞음
interface BeachStations {
  readonly id: string;
  readonly stations: Readonly<
    Record<
      string,
      | { readonly id: string; readonly name: { readonly ko: string } }
      | null
      | undefined
    >
  >;
}

interface StatusReasons {
  readonly reasons: readonly { readonly code: string }[];
}

export function buildPublishSummary(input: {
  readonly version: string;
  readonly previous: string | null;
  readonly publishedAt: string;
  readonly beaches: readonly BeachStations[];
  readonly status: Readonly<Record<string, StatusReasons>>;
}): PublishSummary {
  const stations: Record<
    string,
    { name: string; beachIds: Set<string>; waveBeachIds: Set<string> }
  > = {};
  for (const beach of input.beaches) {
    for (const [metric, station] of Object.entries(beach.stations)) {
      if (!station) continue;
      const use = (stations[station.id] ??= {
        name: station.name.ko,
        beachIds: new Set(),
        waveBeachIds: new Set(),
      });
      use.beachIds.add(beach.id);
      if (metric === "waveHeight") use.waveBeachIds.add(beach.id);
    }
  }
  const delayedBeachIds = Object.entries(input.status)
    .filter(([, status]) =>
      status.reasons.some((reason) => reason.code === "observation_delayed"),
    )
    .map(([id]) => id)
    .sort();
  return {
    version: input.version,
    previous: input.previous,
    publishedAt: input.publishedAt,
    beachCount: input.beaches.length,
    delayedBeachIds,
    stations: Object.fromEntries(
      Object.entries(stations)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([id, use]) => [
          id,
          {
            name: use.name,
            beachIds: [...use.beachIds].sort(),
            waveBeachIds: [...use.waveBeachIds].sort(),
          },
        ]),
    ),
  };
}

export function publishSummaryTtl(nowMs: number): number {
  return Math.floor((nowMs + PUBLISH_SUMMARY_RETENTION_MS) / 1000);
}
