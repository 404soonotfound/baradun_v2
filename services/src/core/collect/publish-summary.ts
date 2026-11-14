import { createHash } from "node:crypto";
import { RUN_RECORD_RETENTION_MS } from "./run-log";

// 게시 요약 (BRD-187, 화면 ADM-COLLECT)
// publisher가 게시에 성공할 때마다 Ops에 남김. 운영 API는 State·게시 파일 대신 이것만 읽음(G1·D16-B2)
// - 분류는 publisher가 게시할 때 한 번 계산한 그대로 옮김. 여기서 다시 판단하지 않음
// - 쓰기가 실패해도 게시는 그대로. 빠진 요약은 previous 사슬로 드러남 → 운영 화면은 '확인 못 함'
// 키: publish#summary / {게시 버전}. 버전 순 정렬 → 기간 조회
// - 버전별 요약은 수백 바이트로 둠(Ops 고정 용량 읽기·쓰기 5). 관측소 표(수 KB)는 해변 파일에서만 나와
//   게시마다 바뀌지 않으므로 STATION_TABLE_KEY 한 곳에 따로 두고 내용이 바뀔 때만 씀

export const PUBLISH_SUMMARY_PK = "publish#summary";

// 관측소 표 한 곳. 운영 API는 GetItem으로 읽음(Query 허용 파티션이 아님)
export const STATION_TABLE_KEY = {
  pk: "publish#stations",
  sk: "current",
} as const;

// 수집 실행 기록과 같은 보존(7일 장애 기록 + 하루 여유)
export const PUBLISH_SUMMARY_RETENTION_MS = RUN_RECORD_RETENTION_MS;

export interface StationUse {
  readonly name: string; // 관측소 한국어 이름(해변 파일 stations.*.name.ko)
  // 이 관측소를 어느 지표로든 쓰는 해변
  readonly beachIds: readonly string[];
  // 이 관측소를 파고로 쓰는 해변. 관측 지연(파고 90분) 분류는 이 해변에만 생김
  readonly waveBeachIds: readonly string[];
}

// 게시 원인. auto: 수집 뒤 자동 게시 · operator: 운영자의 '지금 게시'(D16-C4)
// rollback: 되돌리기(공지만 고른 게시본 때로, 특보·관측은 최신. D20-1~3) · republish: 옛 게시 파일 다시 내보내기(긴급 도구, D20-4)
export type PublishSource = "auto" | "operator" | "rollback" | "republish";

// 게시에 쓴 공지 한 건. 계약(@baradun/contracts)의 Notice와 같은 모양(이 파일은 계약 패키지를 가져오지 않음)
export interface NoticeSnapshot {
  readonly id: string;
  readonly kind: string;
  readonly title: { readonly ko: string; readonly en: string };
  readonly body: { readonly ko: string; readonly en: string };
  readonly startsAt: string;
  readonly endsAt: string | null;
}

export interface PublishChecks {
  readonly format?: boolean;
  readonly required?: boolean;
  readonly beachIds?: boolean;
}

export interface PublishRunDetails {
  readonly checks?: PublishChecks;
  readonly operatorSub?: string;
}

export interface PublishSummary extends PublishRunDetails {
  readonly version: string;
  // 이 게시 직전에 앱에 보이던 버전. 없으면 null(첫 게시)
  readonly previous: string | null;
  readonly publishedAt: string; // UTC ISO
  readonly beachCount: number;
  // 사유에 관측 지연(observation_delayed)이 있는 해변(publisher 분류 그대로)
  readonly delayedBeachIds: readonly string[];
  // 게시 원인. 없으면 자동(이 칸이 생기기 전 요약)
  readonly source?: PublishSource;
  // 되돌리기·다시 내보내기에서 고른 게시본
  readonly target?: string;
  // 분류별 해변 수(publisher 분류 그대로). 운영 화면이 앞 게시와 견줘 '바뀐 것'을 보여 줌(#331)
  // 없으면 이 칸이 생기기 전 요약 → 화면은 '확인 못 함'
  readonly categoryCounts?: CategoryCounts;
  // 게시본에 실은 공지의 요약값(NOTICE_DIGEST_LENGTH자). 앞 게시와 다르면 공지가 바뀐 것
  // 공지 문구는 싣지 않음(요약을 수백 바이트로 유지, 예약 전 문구를 남기지 않음). 없으면 '확인 못 함'
  readonly noticeDigest?: string;
  // 운영자가 운영 API로 연 게시 작업(지금 게시·되돌리기)의 ID. 작업 기록이 늦게 남거나 빠져도 결과를 찾게 함
  readonly jobId?: string;
}

// 분류(계약 BeachStatus.category)별 해변 수
export const PUBLISH_CATEGORIES = [
  "clear",
  "unavailable",
  "undetermined",
] as const;
export type PublishCategory = (typeof PUBLISH_CATEGORIES)[number];
export type CategoryCounts = Readonly<Record<PublishCategory, number>>;

export const NOTICE_DIGEST_LENGTH = 16;

// 칸 순서와 상관없이 견주려고 만든 글자(칸 이름 순으로 정렬한 JSON)
// DynamoDB 맵·게시본 JSON은 칸 순서를 지키지 않을 수 있음 → JSON.stringify를 그대로 견주지 않음
// publisher(되돌림 포인터 비교)·운영 API(대기 공지 비교)·공지 요약값이 같이 씀
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    typeof v === "object" && v !== null && !Array.isArray(v)
      ? Object.fromEntries(
          Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
        )
      : v,
  );
}

// 공지 목록의 요약값. 칸 순서와 상관없는 JSON의 SHA-256 앞부분 → 같은 공지면 같은 값
export function noticeDigestOf(notices: readonly NoticeSnapshot[]): string {
  return createHash("sha256")
    .update(canonicalJson(notices), "utf8")
    .digest("hex")
    .slice(0, NOTICE_DIGEST_LENGTH);
}

// 게시 때의 공지 상태(되돌리기 기준, D20-2): 끝나지 않은 노출본 전부(예약 전 포함, 되돌림 반영 뒤)
// 키: publish#notices / {게시 버전}. 요약과 같은 기간 뒤 지움
// - 요약에 싣지 않고 따로 둠: 요약은 운영 API가 기간 조회로 한꺼번에 읽어 수백 바이트로 유지해야 함(위 설명)
//   공지 문구(공지마다 수백 바이트~1KB)는 되돌릴 때 그 버전 한 건만 읽음
// - 없으면 그때 공지 상태를 모르는 게시(운영 DB를 읽지 못함·이 기록이 생기기 전·다시 내보내기) → 그 버전으로는 되돌릴 수 없음
// - 예약 전 문구가 들어 있어 공개 게시본·운영 API 응답에 그대로 내보내지 않음
export const PUBLISH_NOTICES_PK = "publish#notices";

// 게시 실행 한 번의 결과(D16-C2). 변경이 없어 생략한 것(unchanged)과 실패(failed)를 나눠 남김
// 키: publish#run / last(마지막 실행, 덮어씀) · publish#run / {시도한 버전}(실패한 실행만, 보존 기간 뒤 지움)
// 다른 실행이 게시 중이라 물러난 실행(busy)은 남기지 않음
export const PUBLISH_RUN_PK = "publish#run";
export const PUBLISH_RUN_LAST_SK = "last";
export const PUBLISH_RUN_HISTORY_PREFIX = "run#";

export interface PublishRun extends PublishRunDetails {
  readonly at: string; // 실행 시작(UTC ISO)
  readonly source: PublishSource;
  readonly result: "published" | "unchanged" | "failed";
  // published: 새 버전 · unchanged: 그대로인 지금 버전 · failed: 시도한 버전(게시되지 않음)
  readonly version: string;
  readonly reason?: string; // failed 사유
  readonly target?: string; // 되돌리기·다시 내보내기에서 고른 게시본
  readonly jobId?: string; // 운영자 게시 작업 ID(PublishSummary.jobId와 같음)
}

export type StationTable = Readonly<Record<string, StationUse>>;

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
  readonly category: string;
  readonly reasons: readonly { readonly code: string }[];
}

// 분류별 해변 수. 계약 검사를 통과한 분류만 들어옴. 모르는 분류가 섞이면 null(틀린 수를 보이지 않게)
// 게시 요약과 분류 미리보기(publisher preview)가 같이 씀
export function categoryCountsOf(
  status: Readonly<Record<string, { readonly category: string }>>,
): CategoryCounts | null {
  const counts: Record<PublishCategory, number> = {
    clear: 0,
    unavailable: 0,
    undetermined: 0,
  };
  for (const one of Object.values(status)) {
    if (!(PUBLISH_CATEGORIES as readonly string[]).includes(one.category)) {
      return null;
    }
    counts[one.category as PublishCategory] += 1;
  }
  return counts;
}

export function buildPublishSummary(
  input: PublishRunDetails & {
    readonly version: string;
    readonly previous: string | null;
    readonly publishedAt: string;
    readonly beachCount: number;
    readonly status: Readonly<Record<string, StatusReasons>>;
    readonly source?: PublishSource;
    readonly target?: string;
    // 게시본에 실은 공지. 주면 요약값을 남김
    readonly notices?: readonly NoticeSnapshot[];
    readonly jobId?: string;
  },
): PublishSummary {
  const delayedBeachIds = Object.entries(input.status)
    .filter(([, status]) =>
      status.reasons.some((reason) => reason.code === "observation_delayed"),
    )
    .map(([id]) => id)
    .sort();
  const counts = categoryCountsOf(input.status);
  return {
    version: input.version,
    previous: input.previous,
    publishedAt: input.publishedAt,
    beachCount: input.beachCount,
    delayedBeachIds,
    // 값이 없는 칸은 두지 않음(DynamoDB에 undefined를 쓰지 않음)
    ...(input.source ? { source: input.source } : {}),
    ...(input.target ? { target: input.target } : {}),
    ...(counts ? { categoryCounts: counts } : {}),
    ...(input.notices ? { noticeDigest: noticeDigestOf(input.notices) } : {}),
    ...(input.jobId ? { jobId: input.jobId } : {}),
    ...(input.checks ? { checks: input.checks } : {}),
    ...(input.operatorSub ? { operatorSub: input.operatorSub } : {}),
  };
}

// 관측소별로 그 관측소를 쓰는 해변(해변 파일 stations 그대로). 순서를 고정해 같은 해변 파일이면 같은 글자가 됨
export function buildStationTable(
  beaches: readonly BeachStations[],
): StationTable {
  const stations: Record<
    string,
    { name: string; beachIds: Set<string>; waveBeachIds: Set<string> }
  > = {};
  for (const beach of beaches) {
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
  return Object.fromEntries(
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
  );
}

export function publishSummaryTtl(nowMs: number): number {
  return Math.floor((nowMs + PUBLISH_SUMMARY_RETENTION_MS) / 1000);
}
