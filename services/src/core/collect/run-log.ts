// 수집 실행 기록 (BRD-149, 화면 ADM-COLLECT·ADM-SRC, 아키텍처 18.3 D16-B2)
// 수집기가 실행을 마칠 때마다 결과 한 건을 Ops 테이블에 남김. 운영 화면의 성공률·장애 기록은 이 기록만 씀
// - State 테이블(수집 사실)은 운영 API가 읽지 않음(G1·D16-B2) → 수집 결과를 Ops에 따로 둠
// - 판단에 쓰지 않음. 기록 쓰기가 실패해도 수집·게시는 그대로 진행
// - 원본 응답·인증키는 남기지 않음(아키텍처 10장). 사유는 정해진 짧은 글자(timeout·http:503 등)와 출처 code·정제한 message만
// - 같은 슬롯을 다시 시도하면 기록이 한 건 더 생김(시도마다 한 건)
// 키: collect#run#{job} / {시작 시각 UTC ISO}#{실행 id}. 시각 순 정렬 → 기간 조회(sk BETWEEN)

export const RUN_LOG_PREFIX = "collect#run#";

// 7일 성공률·장애 기록(시안 V9)을 덮고 하루 여유
export const RUN_RECORD_RETENTION_MS = 8 * 24 * 60 * 60 * 1000;

// 한 기록에 남기는 실패 사유 수. 해변별 실패는 같은 사유끼리 묶어 count로 셈
export const RUN_FAILURES_MAX = 10;

export type RunStatus = "complete" | "partial" | "failed";

export interface RunFailure {
  // 수집기 안의 출처 이름(pwncd·tsunami·sea_obs·kma_buoy·rip·photo) 또는 storage(저장 실패)
  readonly source: string;
  readonly reason: string;
  readonly code?: string;
  readonly message?: string;
  // 같은 사유로 실패한 해변 수(이안류·사진). 없으면 1건
  readonly count?: number;
}

// 한 기록에 남기는 빠진 관측소 수(BRD-187). 지금 배정 관측소(53곳)를 모두 담는 크기
// 넘으면 앞에서부터 자르고 missingStationsTotal에 전체 수(운영 화면은 영향 범위를 출처 전체로 봄)
export const MISSING_STATIONS_MAX = 100;

export interface RunRecord {
  readonly job: string;
  readonly slotId: string;
  readonly startedAt: string; // UTC ISO
  readonly finishedAt: string; // UTC ISO
  readonly status: RunStatus;
  readonly failures: readonly RunFailure[];
  // 응답은 왔는데 해변에 배정된 관측소 값이 빠진 관측소 id(collect-ocean만, BRD-187)
  // 실행 상태(status)는 바꾸지 않음 → 관측소 하나가 빠질 때마다 오류 경보가 울리지 않음
  // 없으면(undefined) 대조하지 못함·기록 없음. 빈 배열이면 대조해서 빠진 관측소 없음
  readonly missingStations?: readonly string[];
  readonly missingStationsTotal?: number;
}

export function runLogPk(job: string): string {
  return `${RUN_LOG_PREFIX}${job}`;
}

export function runLogSk(startedAt: string, owner: string): string {
  return `${startedAt}#${owner}`;
}

export function runRecordTtl(nowMs: number): number {
  return Math.floor((nowMs + RUN_RECORD_RETENTION_MS) / 1000);
}

// 같은 출처·사유·code는 한 줄로 묶고 상한까지만 남김(순서는 처음 나온 순)
export function collapseFailures(
  failures: readonly RunFailure[],
): RunFailure[] {
  const merged = new Map<string, RunFailure>();
  for (const failure of failures) {
    const id = JSON.stringify([failure.source, failure.reason, failure.code]);
    const current = merged.get(id);
    merged.set(
      id,
      current
        ? { ...current, count: (current.count ?? 1) + (failure.count ?? 1) }
        : failure,
    );
  }
  return [...merged.values()].slice(0, RUN_FAILURES_MAX);
}

export interface RunLog {
  // 같은 키가 이미 있으면 덮지 않음(같은 실행 id·시각이 두 번 오지 않지만 기록을 바꾸지 않게)
  record(record: RunRecord, owner: string, nowMs: number): Promise<void>;
}
