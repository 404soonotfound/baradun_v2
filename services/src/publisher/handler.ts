import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { S3Client } from "@aws-sdk/client-s3";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import type { Beach } from "@baradun/contracts";
import path from "node:path";
import beachMeta from "../../../data/beach-meta.json";
import weatherAreasJson from "../../../data/weather-areas.json";
import annexTables from "../../../tools/beaches/annex-tables.json";
import { liveNotices, queryNotices } from "../admin/notices";
import { loadBeaches } from "../core/beaches/load";
import { createLogger } from "../core/collect/log";
import { S3SnapshotStore } from "../core/snapshots/s3";
import { DynamoOpsStore, DynamoStateStore } from "../core/store/dynamodb";
import { publishSnapshot, type PublishResult } from "./publish";
import { parseBeachMeta, type SeasonTable } from "./season";
import { parseWeatherAreaTable } from "./weather";
import { zoneTablesFromAnnex, type AnnexTables } from "./zones";

// publish-snapshot Lambda 진입점 (아키텍처 6.2, BRD-61 PR ②)
// 수집기 3개가 수집을 마칠 때마다 비동기로 깨움. 이벤트 내용은 쓰지 않음(State를 다시 읽음)
// 사람이 직접 부르는 이벤트(infra/README '데이터 게시와 되돌리기'). 자동 게시와 같은 게시 잠금을 씀
// - { "action": "rollback", "version": "20261017T053000Z" }: 되돌리기. 공지만 그 게시본 때 상태로 되살려
//   지금 수집 사실과 함께 새 버전으로 게시함(결정 기록 D20-1~3)
// 게시 실패는 오류를 던져 Lambda 오류 지표에 남김(BRD-62 경보). busy·unchanged는 정상
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

export type ManualEvent = {
  action: "rollback";
  version: string;
};

// 사람이 부른 이벤트 해석. action이 없으면 자동 게시(null)
// action이 있는데 모르는 값이거나 버전 형식이 틀리면 던짐: 오타 난 되돌리기를 보통 게시로 돌리지 않음
export function parseManualEvent(event: unknown): ManualEvent | null {
  if (typeof event !== "object" || event === null || !("action" in event)) {
    return null;
  }
  const { action, version } = event as { action: unknown; version?: unknown };
  if (action !== "rollback") {
    throw new Error("모르는 action(rollback만 받음)");
  }
  if (typeof version !== "string" || !VERSION.test(version)) {
    throw new Error("게시 버전 형식 오류(예: 20261017T053000Z)");
  }
  return { action, version };
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

  const manual = parseManualEvent(event);
  const result = await publishSnapshot(
    {
      state: new DynamoStateStore(documents, requiredEnv("STATE_TABLE_NAME")),
      ops,
      // 운영 DB의 공지 노출본(BRD-151). 권한은 admin#notice 파티션 Query만(infra publisher-role)
      notices: async () =>
        liveNotices(
          await queryNotices(documents, opsTable, (noticeId) =>
            log("error", "publish_notice_invalid", { noticeId }),
          ),
        ),
      snapshots,
      beaches,
      beachIds,
      zones,
      seasons,
      weatherAreas,
      log,
      clock,
      owner,
    },
    manual ? { rollbackTo: manual.version } : {},
  );
  if (result.status === "failed") {
    throw new Error(
      manual
        ? `되돌리기 실패: ${result.reason} (${manual.version})`
        : `게시 실패: ${result.reason} (${result.version})`,
    );
  }
  return result;
}
