import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { S3Client } from "@aws-sdk/client-s3";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import type { Beach } from "@baradun/contracts";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import beachMeta from "../../../data/beach-meta.json";
import annexTables from "../../../tools/beaches/annex-tables.json";
import { createLogger } from "../core/collect/log";
import { S3SnapshotStore } from "../core/snapshots/s3";
import { DynamoOpsStore, DynamoStateStore } from "../core/store/dynamodb";
import { publishSnapshot, rollbackManifest, type PublishResult } from "./publish";
import { parseBeachMeta, type SeasonTable } from "./season";
import { zoneTablesFromAnnex, type AnnexTables } from "./zones";

// publish-snapshot Lambda 진입점 (아키텍처 6.2, BRD-61 PR ②)
// 수집기 3개가 수집을 마칠 때마다 비동기로 깨움. 이벤트 내용은 쓰지 않음(State를 다시 읽음)
// 롤백(T06): 사람이 { "action": "rollback", "version": "20261017T053000Z" }로 직접 부름(infra/README)
// 게시 실패는 오류를 던져 Lambda 오류 지표에 남김(BRD-62 경보). busy·unchanged는 정상
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

const BEACH_FILE = /^b[0-9]{4}\.json$/;
const VERSION = /^[0-9]{8}T[0-9]{6}Z$/;

// 해변 파일 읽기. 하나도 없으면 던짐(빈 목록으로 게시해 모든 해변이 사라지지 않게)
// 계약 모양 검사는 게시 전 계약 검사(BeachesFile)가 함
export function loadBeaches(dir: string): Beach[] {
  const names = readdirSync(dir)
    .filter((name) => BEACH_FILE.test(name))
    .sort();
  if (names.length === 0) throw new Error(`해변 파일 없음: ${dir}`);
  return names.map(
    (name) => JSON.parse(readFileSync(path.join(dir, name), "utf8")) as Beach,
  );
}

const log = createLogger(() => []);

// 실행 환경이 살아 있는 동안 다시 씀(연결·파일 읽기 줄임)
let cached:
  | {
      beaches: Beach[];
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
    seasons: meta.seasons,
    documents: DynamoDBDocumentClient.from(new DynamoDBClient({})),
    s3: new S3Client({}),
  };
  return cached;
}

// 구역표는 모듈 로드 때 만듦. 원문이 어긋났으면 시작부터 실패(이름을 골라 쓰지 않음, zones.ts)
const zones = zoneTablesFromAnnex(annexTables as unknown as AnnexTables);

interface LambdaContext {
  readonly awsRequestId: string;
}

export type RollbackEvent = { action: "rollback"; version: string };

function isRollback(event: unknown): event is RollbackEvent {
  return (
    typeof event === "object" &&
    event !== null &&
    (event as { action?: unknown }).action === "rollback"
  );
}

export async function publishHandler(
  event: unknown,
  context: LambdaContext,
): Promise<PublishResult | { status: "rolled_back"; version: string }> {
  const { beaches, seasons, documents, s3 } = setup();
  const snapshots = new S3SnapshotStore(s3, requiredEnv("SNAPSHOT_BUCKET"));

  if (isRollback(event)) {
    const version = event.version;
    if (typeof version !== "string" || !VERSION.test(version)) {
      throw new Error("롤백 버전 형식 오류(예: 20261017T053000Z)");
    }
    const result = await rollbackManifest(snapshots, version);
    if (result.status === "failed") {
      log("error", "rollback_failed", { version, reason: result.reason });
      throw new Error(`롤백 실패: ${result.reason}`);
    }
    log("warn", "rollback_finished", { version });
    return { status: "rolled_back", version };
  }

  const result = await publishSnapshot({
    state: new DynamoStateStore(documents, requiredEnv("STATE_TABLE_NAME")),
    ops: new DynamoOpsStore(documents, requiredEnv("OPS_TABLE_NAME")),
    snapshots,
    beaches,
    zones,
    seasons,
    log,
    clock: () => Date.now(),
    owner: context.awsRequestId,
  });
  if (result.status === "failed") {
    throw new Error(`게시 실패: ${result.reason} (${result.version})`);
  }
  return result;
}
