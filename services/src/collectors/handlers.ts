import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { SSMClient } from "@aws-sdk/client-ssm";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { getText } from "../core/collect/http";
import { createLogger } from "../core/collect/log";
import { SsmApiKeys } from "../core/secrets/ssm";
import { DynamoOpsStore, DynamoStateStore } from "../core/store/dynamodb";
import type { ApiKeyName } from "../core/secrets/api-keys";
import { collectOcean, type CollectDeps, type CollectRunResult } from "./ocean";
import { COLLECT_POLICY } from "./policy";
import { collectWarnings } from "./warnings";

// Lambda 진입점 (아키텍처 5장). 실제 AWS 클라이언트를 묶어 수집 함수에 넘김
// 테이블 이름은 환경 변수(STATE_TABLE_NAME·OPS_TABLE_NAME, PR ② infra가 넣음)
// 다 저장하지 못하면 오류를 던져 Lambda 오류 지표에 남김
// 같은 owner도 lease(2분) 안에는 슬롯을 다시 맡지 않음(10/22 사용자 결정) → lease 안에 온 재시도는 busy로 건너뜀
// 실패한 슬롯은 다음 슬롯이 메움(아키텍처 5장: 재시도는 같은 슬롯 안에서 제한, 다음 슬롯을 막지 않음)

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

function finish(result: CollectRunResult): CollectRunResult {
  if (result.status === "partial" || result.status === "failed") {
    throw new Error(`수집 ${result.status}: ${result.slotId}`);
  }
  return result;
}

export async function oceanHandler(
  _event: unknown,
  context: LambdaContext,
): Promise<CollectRunResult> {
  return finish(await collectOcean(deps(context.awsRequestId)));
}

export async function warningsHandler(
  _event: unknown,
  context: LambdaContext,
): Promise<CollectRunResult> {
  return finish(await collectWarnings(deps(context.awsRequestId)));
}
