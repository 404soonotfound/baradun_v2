import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { S3Client } from "@aws-sdk/client-s3";
import { DynamoDBDocumentClient, GetCommand } from "@aws-sdk/lib-dynamodb";
import type { Beach } from "@baradun/contracts";
import path from "node:path";
import beachMeta from "../../../data/beach-meta.json";
import weatherAreasJson from "../../../data/weather-areas.json";
import annexTables from "../../../tools/beaches/annex-tables.json";
import { liveNotices, queryNotices } from "../admin/notices";
import {
  PUBLISH_JOB_ID,
  publishJobKey,
  type PublishJobOutcome,
} from "../core/collect/publish-job";
import { loadBeaches } from "../core/beaches/load";
import { createLogger } from "../core/collect/log";
import { S3SnapshotStore } from "../core/snapshots/s3";
import { DynamoOpsStore, DynamoStateStore } from "../core/store/dynamodb";
import type { OpsStore as OpsStoreLike } from "../core/store/types";
import { previewSnapshot, type PublishPreview } from "./preview";
import { publishSnapshot, type PublishResult } from "./publish";
import { republishVersion } from "./republish";
import { parseBeachMeta, type SeasonTable } from "./season";
import { parseWeatherAreaTable } from "./weather";
import { zoneTablesFromAnnex, type AnnexTables } from "./zones";

// publish-snapshot Lambda 진입점 (아키텍처 6.2, BRD-61 PR ②)
// 수집기 3개가 수집을 마칠 때마다 비동기로 깨움. 이벤트 내용은 쓰지 않음(State를 다시 읽음)
// 사람이 직접 부르는 이벤트(infra/README '데이터 게시와 되돌리기'). 둘 다 자동 게시와 같은 게시 잠금을 씀
// - { "action": "rollback", "version": "20261017T053000Z" }: 되돌리기. 공지만 그 게시본 때 상태로 되살려
//   지금 수집 사실과 함께 새 버전으로 게시함(결정 기록 D20-1~3)
// - { "action": "republish", "version": "…" }: 옛 게시 파일을 새 버전 번호로 다시 내보냄(급할 때만, D20-4)
// 운영 API가 비동기로 부르는 이벤트(#331, 운영자 게시 작업 core/collect/publish-job.ts). jobId가 있음
// - { "action": "publish", "jobId": "j-…" }: '지금 게시'. 새로 수집하지 않고 마지막 수집 사실 + 확정한 공지(D16-C4)
// - { "action": "rollback", "version": "…", "jobId": "j-…" }: 운영 화면의 되돌리기
//   작업이 '대기'이고 시작 제한 안일 때만 실행함(두 번 오거나 늦게 온 호출은 실행하지 않음). 결과를 작업에 남김
// 게시 변경 미리보기는 이 함수가 아니라 따로 둔 읽기 전용 함수(previewHandler, infra publish-preview.ts)가 맡음
// → 미리보기 호출이 게시 중단 알림(PublishStopped, 이 함수의 실행 수)·게시 오류 알림(이 함수의 오류 수)에 섞이지 않음
// 게시 실패는 오류를 던져 Lambda 오류 지표에 남김(BRD-62 경보). busy·unchanged는 정상
// 사람이 부른 실행의 입력 문제(없는 버전 등)는 던지지 않고 { status: "failed", reason }으로 돌려줌
// 변경이 없어 생략한 실행(unchanged)도 실행으로 세므로 게시 중단 알림(PublishStopped)은 울리지 않고,
// 실패는 오류 알림(PublishErrors)으로 감(D16-C2: 같은 알림을 새로 만들지 않음)
//
// 번들에 들어가는 자료
// - 별표 구역표(tools/beaches/annex-tables.json)·운영 기간(data/beach-meta.json): JSON import → esbuild가 묶음
// - 해변 파일(data/beaches/b*.json): 파일 수가 많아 import 대신 묶을 때 함수 폴더 beaches/로 복사함
//   (infra/lib/publish/publisher.ts의 commandHooks). BEACHES_DIR로 다른 폴더를 줄 수 있음(로컬 실행)

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`환경 변수 없음: ${name}`);
  return value;
}

const VERSION = /^[0-9]{8}T[0-9]{6}Z$/;

const log = createLogger(() => []);

// 실행 환경이 살아 있는 동안 다시 씀(연결·파일 읽기 줄임)
let cached:
  | {
      beaches: Beach[];
      beachIds: string[];
      seasons: SeasonTable;
      documents: DynamoDBDocumentClient;
      s3: S3Client;
    }
  | undefined;

function setup() {
  if (cached) return cached;
  const meta = parseBeachMeta(beachMeta);
  if (meta.invalid.length > 0) {
    // 정보 배지만 숨겨짐. 게시는 계속함(특보·관측 분류가 멈추면 안 됨)
    log("warn", "season_meta_invalid", { beachIds: meta.invalid });
  }
  cached = {
    beaches: loadBeaches(
      process.env.BEACHES_DIR ?? path.join(__dirname, "beaches"),
    ),
    // 저장소 원본 해변 ID 목록: beach-meta.json의 해변 칸(JSON import로 묶임). 폴더째 복사한 해변 파일과
    // 따로 들어오므로 게시 전에 둘을 대조함(D16-C1)
    beachIds: [...meta.beachIds],
    seasons: meta.seasons,
    documents: DynamoDBDocumentClient.from(new DynamoDBClient({})),
    s3: new S3Client({}),
  };
  return cached;
}

// 날씨 예보 구역표(BRD-181). 틀린 항목은 빼고 알림(날씨 때문에 판단 게시를 멈추지 않음)
const weatherAreas = parseWeatherAreaTable(weatherAreasJson, log);

// 구역표는 모듈 로드 때 만듦. 원문이 어긋났으면 시작부터 실패(이름을 골라 쓰지 않음, zones.ts)
const zones = zoneTablesFromAnnex(annexTables as unknown as AnnexTables);

interface LambdaContext {
  readonly awsRequestId: string;
}

export type ManualEvent =
  | { action: "rollback"; version: string; jobId?: string }
  | { action: "republish"; version: string }
  | { action: "publish"; jobId: string };

// 사람이 부른 이벤트 해석. action이 없으면 자동 게시(null)
// action이 있는데 모르는 값이거나 버전·작업 ID 형식이 틀리면 던짐: 오타 난 되돌리기를 보통 게시로 돌리지 않음
export function parseManualEvent(event: unknown): ManualEvent | null {
  if (typeof event !== "object" || event === null || !("action" in event)) {
    return null;
  }
  const { action, version, jobId } = event as {
    action: unknown;
    version?: unknown;
    jobId?: unknown;
  };
  if (action !== "rollback" && action !== "republish" && action !== "publish") {
    throw new Error("모르는 action(rollback·republish·publish만 받음)");
  }
  if (
    jobId !== undefined &&
    (typeof jobId !== "string" || !PUBLISH_JOB_ID.test(jobId))
  ) {
    throw new Error("작업 ID 형식 오류(예: j-0123456789ab)");
  }
  if (action === "publish") {
    // '지금 게시'는 운영 API 작업으로만 부름(작업 없이 부르면 결과를 볼 곳이 없음)
    if (jobId === undefined) throw new Error("publish에는 jobId가 필요함");
    return { action, jobId };
  }
  if (typeof version !== "string" || !VERSION.test(version)) {
    throw new Error("게시 버전 형식 오류(예: 20261017T053000Z)");
  }
  if (action === "republish") {
    // 다시 내보내기는 명령줄 도구만(운영 화면 버튼 없음, D20-4)
    if (jobId !== undefined) throw new Error("republish에는 jobId를 받지 않음");
    return { action, version };
  }
  return jobId === undefined ? { action, version } : { action, version, jobId };
}

// 게시 결과 → 작업 결과. busy(다른 게시가 잠금을 잡음)는 이 작업이 게시하지 않은 것 → 실패(busy)
export function jobOutcomeOf(result: PublishResult): PublishJobOutcome {
  switch (result.status) {
    case "published":
    case "unchanged":
      return {
        state: "done",
        result: result.status,
        snapshotVersion: result.version,
      };
    case "busy":
      return { state: "failed", reason: "busy" };
    case "failed":
      return {
        state: "failed",
        reason: result.reason,
        snapshotVersion: result.version,
      };
  }
}

// 사람이 부른 실행에서 입력이 잘못된 경우의 실패 사유(없는 버전·기록이 없는 버전 등)
// 게시 장애가 아니므로 던지지 않고 결과로 돌려줌 → 게시 오류 알림(PublishErrors)이 울리지 않음(D16-C2)
export const MANUAL_INPUT_FAILURES: readonly string[] = [
  "rollback_target_missing",
  "rollback_target_invalid",
  "manifest_missing",
  "files_missing",
  "files_mismatch",
  "policy_unsupported",
];

// 이 결과를 오류로 던져 Lambda 오류 지표에 남길지. 자동 게시의 실패와, 사람이 부른 실행의 입력 문제가 아닌 실패
// false여도 실패일 수 있음(입력 문제) → 타입을 좁히지 않고 참·거짓만 돌려줌
export function isPublishFault(
  manual: ManualEvent | null,
  result: PublishResult,
): boolean {
  return (
    result.status === "failed" &&
    !(manual !== null && MANUAL_INPUT_FAILURES.includes(result.reason))
  );
}

// 작업이 있는 실행: 작업을 맡은 뒤 게시하고 결과를 작업에 남김. 못 맡으면 게시하지 않음(busy로 돌려줌)
// 결과를 남기지 못하면 경고만(실행 기록·게시 요약의 jobId로 운영 API가 결과를 찾음)
export async function runPublishJob(
  deps: {
    readonly ops: Pick<OpsStoreLike, "claimPublishJob" | "finishPublishJob">;
    readonly clock: () => number;
    readonly log: typeof log;
  },
  jobId: string,
  run: () => Promise<PublishResult>,
): Promise<PublishResult> {
  const claim = await deps.ops.claimPublishJob(jobId, deps.clock());
  if (claim !== "claimed") {
    deps.log(claim === "missing" ? "error" : "warn", "publish_job_skipped", {
      jobId,
      claim,
    });
    return { status: "busy" };
  }
  let result: PublishResult;
  try {
    result = await run();
  } catch (error) {
    await deps.ops
      .finishPublishJob(
        jobId,
        {
          state: "failed",
          reason: `exception:${error instanceof Error ? error.name : typeof error}`,
        },
        deps.clock(),
      )
      .catch(() => false);
    throw error;
  }
  const finished = await deps.ops
    .finishPublishJob(jobId, jobOutcomeOf(result), deps.clock())
    .catch(() => false);
  if (!finished) {
    deps.log("warn", "publish_job_not_recorded", {
      jobId,
      result: result.status,
    });
  }
  return result;
}

export async function publishHandler(
  event: unknown,
  context: LambdaContext,
): Promise<PublishResult> {
  const { beaches, beachIds, seasons, documents, s3 } = setup();
  const snapshots = new S3SnapshotStore(s3, requiredEnv("SNAPSHOT_BUCKET"));
  const opsTable = requiredEnv("OPS_TABLE_NAME");
  const ops = new DynamoOpsStore(documents, opsTable);
  const clock = () => Date.now();
  const owner = context.awsRequestId;

  // 운영 DB의 공지 노출본(BRD-151). 권한은 admin#notice 파티션 Query만(infra publisher-role)
  const notices = async () =>
    liveNotices(
      await queryNotices(documents, opsTable, (noticeId) =>
        log("error", "publish_notice_invalid", { noticeId }),
      ),
    );

  const manual = parseManualEvent(event);
  if (manual?.action === "republish") {
    const result = await republishVersion(
      { ops, snapshots, notices, log, clock, owner },
      manual.version,
    );
    if (result.status === "failed" && isPublishFault(manual, result)) {
      throw new Error(
        `다시 내보내기 실패: ${result.reason} (${manual.version})`,
      );
    }
    return result;
  }

  const jobId = manual?.jobId;
  const publish = async () => {
    // 작업을 맡은 뒤 운영 API가 기록한 sub만 읽음
    const job =
      jobId && manual?.action === "publish"
        ? await documents
            .send(
              new GetCommand({
                TableName: opsTable,
                Key: publishJobKey(jobId),
                ConsistentRead: true,
              }),
            )
            .catch(() => undefined)
        : undefined;
    const operatorSub = job?.Item?.operatorSub;
    return publishSnapshot(
      {
        state: new DynamoStateStore(documents, requiredEnv("STATE_TABLE_NAME")),
        ops,
        notices,
        snapshots,
        beaches,
        beachIds,
        zones,
        seasons,
        weatherAreas,
        log,
        clock,
        owner,
        ...(manual?.action === "publish" ? { source: "operator" } : {}),
        ...(jobId !== undefined ? { jobId } : {}),
        ...(typeof operatorSub === "string" ? { operatorSub } : {}),
      },
      manual?.action === "rollback" ? { rollbackTo: manual.version } : {},
    );
  };
  const result =
    jobId === undefined
      ? await publish()
      : await runPublishJob({ ops, clock, log }, jobId, publish);
  if (result.status === "failed" && isPublishFault(manual, result)) {
    throw new Error(
      manual?.action === "rollback"
        ? `되돌리기 실패: ${result.reason} (${manual.version})`
        : manual?.action === "publish"
          ? `지금 게시 실패: ${result.reason} (${result.version})`
          : `게시 실패: ${result.reason} (${result.version})`,
    );
  }
  return result;
}

// 게시 변경 미리보기 함수 진입점 (#331, 캔버스 N2). 운영 API가 동기 호출로 부름
// publisher와 같은 코드·해변 자료로 분류만 미리 계산함(preview.ts). 역할은 State·게시본 읽기만(infra publish-preview.ts)
// 게시 잠금·S3 쓰기·Ops를 쓰지 않으므로 OPS_TABLE_NAME도 받지 않음. 이벤트 내용은 쓰지 않음
export async function previewHandler(): Promise<PublishPreview> {
  const { beaches, beachIds, seasons, documents, s3 } = setup();
  return previewSnapshot({
    state: new DynamoStateStore(documents, requiredEnv("STATE_TABLE_NAME")),
    snapshots: new S3SnapshotStore(s3, requiredEnv("SNAPSHOT_BUCKET")),
    beaches,
    beachIds,
    zones,
    seasons,
    log,
    clock: () => Date.now(),
  });
}
