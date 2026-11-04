import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";
import { SSMClient } from "@aws-sdk/client-ssm";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { getText } from "../core/collect/http";
import { createLogger, maskSecrets } from "../core/collect/log";
import type { RunFailure } from "../core/collect/run-log";
import { SsmApiKeys } from "../core/secrets/ssm";
import {
  DynamoOpsStore,
  DynamoRunLog,
  DynamoStateStore,
} from "../core/store/dynamodb";
import type { ApiKeyName } from "../core/secrets/api-keys";
import photoLedger from "../../../data/photo-sources.json";
import ripLedger from "../../../data/rip-current-beaches.json";
import {
  CATALOG_JOB,
  collectCatalog,
  parsePhotoLedger,
  type PhotoSource,
} from "./catalog";
import {
  collectOcean,
  OCEAN_JOB,
  type CollectDeps,
  type CollectRunResult,
} from "./ocean";
import { COLLECT_POLICY } from "./policy";
import { collectRip, parseRipLedger, RIP_JOB, type RipSource } from "./rip";
import { runCollector } from "./trigger";
import { collectWarnings, WARNINGS_JOB } from "./warnings";
import { formatUtcIso } from "../core/warnings/time";

// Lambda 진입점 (아키텍처 5장). 실제 AWS 클라이언트를 묶어 수집 함수에 넘김
// 테이블 이름은 환경 변수(STATE_TABLE_NAME·OPS_TABLE_NAME, PR ② infra가 넣음)
// 다 저장하지 못하면 오류를 던져 Lambda 오류 지표에 남김
// 같은 owner도 lease(2분) 안에는 슬롯을 다시 맡지 않음(10/22 사용자 결정) → lease 안에 온 재시도는 busy로 건너뜀
// 실패한 슬롯은 다음 슬롯이 메움(아키텍처 5장: 재시도는 같은 슬롯 안에서 제한, 다음 슬롯을 막지 않음)
// 수집을 마치면 publish-snapshot을 비동기로 깨움(아키텍처 6.2, BRD-61 PR ②) → triggerPublish 설명
// 슬롯을 맡은 실행은 그 전에 실행 기록을 Ops에 남김(BRD-149, 운영 화면 수집 현황). 사유 글에서 읽은 키를 가림

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`환경 변수 없음: ${name}`);
  return value;
}

// 실행 환경이 살아 있는 동안 다시 씀(연결·키 읽기 줄임)
const documents = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const keys = new SsmApiKeys(new SSMClient({}));
const loadedKeys: string[] = [];

// 로그에서 가릴 값: 이번 실행 환경이 읽은 키 전부
const log = createLogger(() => loadedKeys);
const maskedKeys = {
  async get(name: ApiKeyName): Promise<string> {
    const value = await keys.get(name);
    if (!loadedKeys.includes(value)) loadedKeys.push(value);
    return value;
  },
};

function deps(owner: string): CollectDeps {
  return {
    state: new DynamoStateStore(documents, requiredEnv("STATE_TABLE_NAME")),
    ops: new DynamoOpsStore(documents, requiredEnv("OPS_TABLE_NAME")),
    keys: maskedKeys,
    get: (url) =>
      getText(url, {
        timeoutMs: COLLECT_POLICY.httpTimeoutMs,
        retries: COLLECT_POLICY.httpRetries,
        retryDelayMs: COLLECT_POLICY.httpRetryDelayMs,
      }),
    log,
    clock: () => Date.now(),
    owner,
  };
}

// Lambda context에서 쓰는 칸만 받음(@types/aws-lambda 없이)
interface LambdaContext {
  readonly awsRequestId: string;
}

const lambda = new LambdaClient({});

// 사유·message에 키가 섞여 들어와도 기록에 남기지 않게 가림(로그와 같은 규칙)
function maskFailure(failure: RunFailure): RunFailure {
  const masked = {
    ...failure,
    reason: maskSecrets(failure.reason, loadedKeys),
  };
  return failure.message === undefined
    ? masked
    : { ...masked, message: maskSecrets(failure.message, loadedKeys) };
}

// 수집 함수가 예외로 끝나도 실행 기록에 실패로 남김(trigger.ts runCollector)
async function run(
  job: string,
  context: LambdaContext,
  collect: () => Promise<CollectRunResult>,
): Promise<CollectRunResult> {
  const startedMs = Date.now();
  const runLog = new DynamoRunLog(documents, requiredEnv("OPS_TABLE_NAME"));
  return runCollector(collect, {
    record: async (claimed) => {
      const nowMs = Date.now();
      await runLog.record(
        {
          job,
          slotId: claimed.slotId,
          startedAt: formatUtcIso(startedMs),
          finishedAt: formatUtcIso(nowMs),
          status: claimed.status,
          failures:
            claimed.status === "complete"
              ? []
              : claimed.failures.map(maskFailure),
        },
        context.awsRequestId,
        nowMs,
      );
    },
    invoke: async () => {
      await lambda.send(
        new InvokeCommand({
          FunctionName: requiredEnv("PUBLISHER_FUNCTION_NAME"),
          InvocationType: "Event", // 비동기. 게시 결과를 기다리지 않음
        }),
      );
    },
    log,
  });
}

export async function oceanHandler(
  _event: unknown,
  context: LambdaContext,
): Promise<CollectRunResult> {
  return run(OCEAN_JOB, context, () =>
    collectOcean(deps(context.awsRequestId)),
  );
}

export async function warningsHandler(
  _event: unknown,
  context: LambdaContext,
): Promise<CollectRunResult> {
  return run(WARNINGS_JOB, context, () =>
    collectWarnings(deps(context.awsRequestId)),
  );
}

// 확인할 사진 목록은 빌드 때 번들에 들어감(data/photo-sources.json, esbuild가 JSON을 그대로 묶음)
// 모양이 틀리면 catalog 첫 실행에서 던져 실패함(틀린 목록으로 돌지 않음)
// 모듈 로드 때 검사하지 않음: 세 수집기가 이 파일 하나를 진입점으로 쓰므로,
// 여기서 던지면 대장 문제가 ocean·warnings(특보·관측) Lambda까지 시작 실패로 끌고 감
let catalogPhotos: readonly PhotoSource[] | null = null;

export async function catalogHandler(
  _event: unknown,
  context: LambdaContext,
): Promise<CollectRunResult> {
  const photos = (catalogPhotos ??= parsePhotoLedger(photoLedger));
  return run(CATALOG_JOB, context, () =>
    collectCatalog({ ...deps(context.awsRequestId), photos }),
  );
}

// 이안류 대응표도 번들에 들어감(data/rip-current-beaches.json). catalog와 같은 이유로 첫 실행에서 검사
let ripSources: readonly RipSource[] | null = null;

export async function ripHandler(
  _event: unknown,
  context: LambdaContext,
): Promise<CollectRunResult> {
  const sources = (ripSources ??= parseRipLedger(ripLedger));
  return run(RIP_JOB, context, () =>
    collectRip({ ...deps(context.awsRequestId), sources }),
  );
}
