import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { S3Client } from "@aws-sdk/client-s3";
import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyStructuredResultV2,
} from "aws-lambda";
import {
  actorOf,
  countAudit,
  listAudit,
  parseAuditQuery,
  recordAudit,
  type AuditEntry,
} from "./audit";
import {
  beachMemoGetRoute,
  beachMemoPutRoute,
  beachStatusRoute,
} from "./beaches";
import { readCollection } from "./collection";
import { cloudWatchAlarmReader, type AlarmReader } from "./collection-alarms";
import type { ApiKeyTags } from "../core/secrets/api-keys";
import { S3SnapshotStore } from "../core/snapshots/s3";
import type { SnapshotStore } from "../core/snapshots/types";
import { readSources, ssmKeyTagReader } from "./sources";
import {
  authenticate,
  createTokenVerifier,
  type AuthDependencies,
  type AuthFailure,
  type Principal,
} from "./auth";
import {
  errorJson,
  header,
  json,
  newRequestIds,
  readJsonBody,
  safeLog,
  type ErrorCode,
  type RequestIds,
} from "./http";
import {
  applyRedactions,
  countInquiries,
  decodeCursor,
  getInquiry,
  INQUIRY_PAGE_DEFAULT,
  INQUIRY_PAGE_MAX,
  inquiryAuditChanges,
  inquiryPatchFields,
  listInquiries,
  parseInquiryPatch,
} from "./inquiries";
import {
  createNoticeRoute,
  deleteNoticeRoute,
  endNoticeRoute,
  exposeNoticeRoute,
  listNoticesRoute,
  updateNoticeRoute,
} from "./notice-routes";
import {
  ACCESS_TOKEN_HEADER,
  IDEMPOTENCY_KEY,
  IDEMPOTENCY_KEY_HEADER,
  OPS_SESSION_MAX_MS,
} from "./policy";
import {
  createPublishJobRoute,
  publishJobRoute,
  publishOverviewRoute,
  publishPreviewRoute,
  PREVIEW_WAIT_MS,
  reapplyNoticeRoute,
  rollbackPreviewRoute,
  type PublisherInvoker,
} from "./publish-routes";
import { decideRoute, matchRoute } from "./routes";
import {
  cognitoMfaResetter,
  mfaResetRoute,
  type MfaResetter,
} from "./mfa-reset";
import { readSamplePolicy } from "./sample";
import { sampleInquiry, sampleInquiryPage, sampleStats } from "./sample-data";
import {
  createCachedStatsReader,
  createGa4StatsReader,
  parseStatsRange,
  unconfiguredStats,
  type StatsReader,
} from "./stats";
import { payloadHashOf, versionedWrite, type Sender } from "./writes";
import { INQUIRY_ID, isInquiryStatus } from "../inquiry/policy";

// 운영 API 단일 함수 /ops/* (D16-B1·E4). 입구는 관리자 사이트 CloudFront + OAC + 함수 URL(BRD-147에서 연결)
// 순서: 요청 ID → 토큰 검증(역할·샘플 허용) → 허용표 → 업무 처리
// 업무 경로가 늘면 handle의 분기만 더함. 인증·허용표를 건너뛰는 경로는 두지 않음

export interface DataDependencies {
  readonly client: Sender;
  readonly opsTable: string;
  readonly inquiryTable: string;
  readonly now: () => Date;
  // CloudWatch 경보 읽기(수집 현황, BRD-187). 없으면 경보는 '확인 못 함'
  readonly alarms?: AlarmReader | null;
  // 인증키 태그 읽기(데이터 출처). 없으면 키는 '확인 못 함'
  readonly keys?: ApiKeyTags | null;
  // 게시본 읽기(해변 관리의 지금 표시 상태, BRD-150). 없으면 상태는 '확인 못 함'(판단불가 계열)
  readonly snapshots?: SnapshotStore | null;
  // publisher 비동기 호출(지금 게시·되돌리기 작업, #331). 없으면 작업을 만들지 않음(500)
  readonly publisher?: PublisherInvoker | null;
  // 운영자 풀 계정 확인·인증 앱 지우기(2단계 인증 초기화, #335). 없으면 그 요청만 500
  readonly mfaReset?: MfaResetter | null;
  // GA4 이용 통계 읽기(#333 ADM-STATS). 없으면 configured: false 안내
  readonly stats?: StatsReader | null;
}

export interface OpsDependencies {
  readonly auth: AuthDependencies;
  readonly data: DataDependencies;
  readonly ids?: () => RequestIds;
}

type Result = APIGatewayProxyStructuredResultV2;

// GET /ops/inquiries?status=&cursor=&limit=
async function listRoute(
  event: APIGatewayProxyEventV2,
  principal: Principal,
  data: DataDependencies,
  ids: RequestIds,
): Promise<Result> {
  const params = event.queryStringParameters ?? {};
  const status = params.status;
  if (status !== undefined && !isInquiryStatus(status)) {
    return errorJson(400, "invalid_request", ids, { field: "status" });
  }
  const limit =
    params.limit === undefined ? INQUIRY_PAGE_DEFAULT : Number(params.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > INQUIRY_PAGE_MAX) {
    return errorJson(400, "invalid_request", ids, { field: "limit" });
  }
  const cursor =
    params.cursor === undefined ? undefined : decodeCursor(params.cursor);
  // 다른 상태 목록의 cursor를 섞어 쓰지 않게 함
  // 상태를 고른 목록은 키가 있는 cursor만 받음(전체 목록의 '다음 상태부터' cursor는 처음부터 다시 읽게 되어 중복)
  if (
    cursor === null ||
    (cursor && status && (cursor.s !== status || !cursor.k))
  ) {
    return errorJson(400, "invalid_request", ids, { field: "cursor" });
  }
  if (principal.kind === "sample") {
    return json(200, sampleInquiryPage(status, data.now()), ids);
  }
  const now = data.now();
  const page = await listInquiries(
    data.client,
    data.inquiryTable,
    { ...(status ? { status } : {}), ...(cursor ? { cursor } : {}), limit },
    now,
  );
  // 상태 탭의 문의 수는 첫 쪽에만 실음(다음 쪽마다 다시 세지 않음). 상태 GSI 읽기 용량이 작아 목록 뒤에 차례로 읽음
  const counts = cursor
    ? undefined
    : await countInquiries(data.client, data.inquiryTable, now);
  return json(200, counts ? { ...page, counts } : page, ids);
}

// GET /ops/inquiries/{id}
async function detailRoute(
  id: string,
  principal: Principal,
  data: DataDependencies,
  ids: RequestIds,
): Promise<Result> {
  if (!INQUIRY_ID.test(id)) return errorJson(404, "not_found", ids);
  const detail =
    principal.kind === "sample"
      ? sampleInquiry(id, data.now())
      : await getInquiry(
          data.client,
          data.inquiryTable,
          id,
          principal.role,
          data.now(),
        );
  return detail ? json(200, detail, ids) : errorJson(404, "not_found", ids);
}

// PATCH /ops/inquiries/{id}: 처리 상태·반려 이유·내부 메모·개인정보 가리기 (D16-D5·D6, B6)
async function patchRoute(
  event: APIGatewayProxyEventV2,
  id: string,
  principal: Principal & { kind: "operator" },
  data: DataDependencies,
  ids: RequestIds,
): Promise<Result> {
  if (!INQUIRY_ID.test(id)) return errorJson(404, "not_found", ids);
  const key = header(event, IDEMPOTENCY_KEY_HEADER);
  if (!key || !IDEMPOTENCY_KEY.test(key)) {
    return errorJson(400, "invalid_request", ids, { field: "idempotencyKey" });
  }
  const body = readJsonBody(event);
  if (!body) return errorJson(400, "invalid_request", ids, { field: "body" });
  const check = parseInquiryPatch(body.value);
  if (!check.ok) {
    return errorJson(400, "invalid_request", ids, { field: check.field });
  }

  // 없거나 보관 기한이 지난 문의는 404(쓰기 조건에서도 다시 막음)
  const now = data.now();
  const current = await getInquiry(
    data.client,
    data.inquiryTable,
    id,
    principal.role,
    now,
  );
  if (!current) return errorJson(404, "not_found", ids);

  const fields = inquiryPatchFields(check.patch);
  // 개인정보 가리기: 화면이 본 version의 본문에서만 계산함. version이 다르면 지금 본문을 그대로 넣어
  // 쓰기를 시도 → 같은 키 재시도면 앞 결과, 아니면 version 조건에 걸려 409(어느 쪽도 본문을 바꾸지 않음)
  if (check.patch.redactions !== undefined) {
    const message =
      current.version === check.patch.version
        ? applyRedactions(current.message ?? "", check.patch.redactions)
        : (current.message ?? "");
    if (message === null) {
      return errorJson(400, "invalid_request", ids, { field: "redactions" });
    }
    fields.message = message;
  }
  // 이전 도구를 돌리기 전 문의(상태·version 없음)는 메모만 바꿔도 목록(GSI)에 들어가게 상태를 '접수'로 함께 채움
  // 이미 상태가 있는 이전 문의(version 1 이상)는 상태를 건드리지 않음(메모만 바꿀 때 '확인 중'이 되돌아가지 않게)
  if (current.legacy && current.version === 0) {
    fields.legacy = true;
    fields.inquiryStatus ??= "received";
  }
  const result = await versionedWrite(
    data.client,
    { ops: data.opsTable, inquiry: data.inquiryTable },
    {
      target: { kind: "inquiry", inquiryId: id },
      expectedVersion: check.patch.version,
      set: fields,
      idempotencyKey: key,
      payloadHash: payloadHashOf(body.raw),
      actorSub: principal.sub,
      // 본문·메모·반려 이유 글은 넣지 않고 바뀐 항목 이름과 상태 앞·뒤만(D16-B5·D6)
      audit: {
        actor: actorOf(principal),
        action: "inquiry.update",
        target: { kind: "inquiry", id },
        changes: inquiryAuditChanges(check.patch, current),
        ...(check.patch.status
          ? { statusFrom: current.status, statusTo: check.patch.status }
          : {}),
        ids,
      },
    },
    now,
  );
  if (result.status === "conflict") {
    return errorJson(409, "conflict", ids, { reason: result.reason });
  }
  safeLog("info", "ops_inquiry_updated", {
    inquiryId: id,
    version: result.version,
    replayed: result.status === "replayed" ? 1 : 0,
    traceId: ids.traceId,
  });
  return json(200, { inquiryId: id, version: result.version }, ids);
}

// GET /ops/audit: 변경 이력(읽기 전용). 샘플은 허용표에서 막힘(D15-3 변경 이력 응답 안 함)
async function auditRoute(
  event: APIGatewayProxyEventV2,
  data: DataDependencies,
  ids: RequestIds,
): Promise<Result> {
  const check = parseAuditQuery(event.queryStringParameters ?? {}, data.now());
  if (!check.ok) {
    return errorJson(400, "invalid_request", ids, { field: check.field });
  }
  const now = data.now();
  const page = await listAudit(data.client, data.opsTable, check.query, now);
  // 탭 수는 첫 쪽에만(다음 쪽마다 기간 전체를 다시 세지 않게)
  // 화면이 이미 같은 거르기의 수를 가졌으면(분류 탭만 바꿈) counts=0으로 세지 않게 함
  const counts =
    check.query.cursor || event.queryStringParameters?.counts === "0"
      ? undefined
      : await countAudit(data.client, data.opsTable, check.query.filter, now);
  return json(200, counts ? { ...page, counts } : page, ids);
}

// 샘플 요청 기록의 대상: 경로 모양만(문의 ID 등 실제 값은 넣지 않음)
function routeTarget(path: string, method: string): AuditEntry["target"] {
  let pattern = "unknown";
  try {
    pattern = matchRoute(path)?.pattern ?? "unknown";
  } catch {
    // 잘못된 % 인코딩은 unknown
  }
  return { kind: "route", id: `${method} ${pattern}` };
}

const AUTH_STATUS: Record<AuthFailure, 401 | 403> = {
  missing_token: 401,
  invalid_token: 401,
  session_expired: 401,
  role_unclear: 403,
  sample_not_allowed: 403,
};

const ROUTE_CODE: Record<403 | 404 | 405, ErrorCode> = {
  403: "forbidden",
  404: "not_found",
  405: "method_not_allowed",
};

function meBody(principal: Principal) {
  return {
    kind: principal.kind,
    role: principal.kind === "operator" ? principal.role : "sample",
    // 화면이 남은 세션을 보여 주고 8시간 전에 다시 로그인을 안내하는 데 씀
    authTime: new Date(principal.authTime * 1000).toISOString(),
    sessionExpiresAt: new Date(
      principal.authTime * 1000 + OPS_SESSION_MAX_MS,
    ).toISOString(),
  };
}

export async function handleOps(
  event: APIGatewayProxyEventV2,
  deps: OpsDependencies,
): Promise<APIGatewayProxyStructuredResultV2> {
  const ids = (deps.ids ?? newRequestIds)();
  const res = await dispatchOps(event, deps, ids);
  // 결정 기록 D17-7: 운영 API 401·403 권한 거부 급증 감시 로그
  // traceId로 같은 요청의 사유 줄(ops_auth_rejected·ops_route_rejected)과 짝지음
  if (res.statusCode === 401 || res.statusCode === 403) {
    safeLog("warn", "ops_auth_denied", {
      status: res.statusCode,
      traceId: ids.traceId,
    });
  }
  return res;
}

async function dispatchOps(
  event: APIGatewayProxyEventV2,
  deps: OpsDependencies,
  ids: RequestIds,
): Promise<APIGatewayProxyStructuredResultV2> {
  const path = event.rawPath;
  const method = event.requestContext?.http?.method ?? "";

  try {
    const auth = await authenticate(
      header(event, ACCESS_TOKEN_HEADER),
      deps.auth,
    );
    if (!auth.ok) {
      safeLog("warn", "ops_auth_rejected", {
        reason: auth.reason,
        path,
        method,
        traceId: ids.traceId,
      });
      return errorJson(AUTH_STATUS[auth.reason], auth.reason, ids);
    }

    const decision = decideRoute(path, method, auth.principal);
    // 샘플 계정은 로그인(/ops/me)·조회·거절을 모두 기록함(BRD-155). 기록하지 못하면 응답하지 않음(500)
    if (auth.principal.kind === "sample") {
      await recordAudit(
        deps.data.client,
        deps.data.opsTable,
        {
          actor: actorOf(auth.principal),
          action: decision.ok ? "sample.read" : "sample.denied",
          target: routeTarget(path, method),
          changes: [],
          ids,
        },
        deps.data.now(),
      );
    }
    if (!decision.ok) {
      safeLog("warn", "ops_route_rejected", {
        status: decision.status,
        path,
        method,
        kind: auth.principal.kind,
        traceId: ids.traceId,
      });
      return errorJson(decision.status, ROUTE_CODE[decision.status], ids);
    }

    const principal = auth.principal;
    if (decision.pattern === "/ops/me" && method === "GET") {
      return json(200, meBody(principal), ids);
    }
    if (decision.pattern === "/ops/inquiries" && method === "GET") {
      return await listRoute(event, principal, deps.data, ids);
    }
    if (decision.pattern === "/ops/collection" && method === "GET") {
      const view = await readCollection(
        deps.data.client,
        deps.data.opsTable,
        deps.data.now(),
        deps.data.alarms ?? null,
      );
      return json(200, view, ids);
    }
    if (decision.pattern === "/ops/sources" && method === "GET") {
      const view = await readSources(
        deps.data.client,
        deps.data.opsTable,
        deps.data.now(),
        deps.data.keys ?? null,
        // 샘플(시연) 계정은 운영 키 등록 여부·만료일을 받지 않음
        { hideKeys: principal.kind === "sample" },
      );
      return json(200, view, ids);
    }
    if (decision.pattern === "/ops/audit" && method === "GET") {
      return await auditRoute(event, deps.data, ids);
    }
    if (decision.pattern === "/ops/beaches/published" && method === "GET") {
      return await beachStatusRoute(deps.data, ids);
    }
    if (decision.pattern === "/ops/stats" && method === "GET") {
      const range = parseStatsRange(event.queryStringParameters?.range);
      if (!range) {
        return errorJson(400, "invalid_request", ids);
      }
      if (principal.kind === "sample") {
        return json(200, sampleStats(range, deps.data.now()), ids);
      }
      if (!deps.data.stats) {
        return json(200, unconfiguredStats(range, deps.data.now()), ids);
      }
      return json(200, await deps.data.stats.read(range), ids);
    }
    if (decision.pattern === "/ops/beaches/{id}/memo") {
      const id = decision.params.id ?? "";
      if (method === "GET") {
        return await beachMemoGetRoute(id, deps.data, ids);
      }
      if (method === "PUT" && principal.kind === "operator") {
        return await beachMemoPutRoute(event, id, principal, deps.data, ids);
      }
    }
    if (decision.pattern === "/ops/notices") {
      if (method === "GET") {
        return await listNoticesRoute(principal, deps.data, ids);
      }
      if (method === "POST" && principal.kind === "operator") {
        return await createNoticeRoute(event, principal, deps.data, ids);
      }
    }
    if (
      decision.pattern.startsWith("/ops/notices/{id}") &&
      principal.kind === "operator"
    ) {
      const id = decision.params.id ?? "";
      if (decision.pattern === "/ops/notices/{id}") {
        if (method === "PUT") {
          return await updateNoticeRoute(event, id, principal, deps.data, ids);
        }
        if (method === "DELETE") {
          return await deleteNoticeRoute(event, id, principal, deps.data, ids);
        }
      }
      if (decision.pattern === "/ops/notices/{id}/expose") {
        return await exposeNoticeRoute(event, id, principal, deps.data, ids);
      }
      if (decision.pattern === "/ops/notices/{id}/end") {
        return await endNoticeRoute(event, id, principal, deps.data, ids);
      }
    }
    if (decision.pattern === "/ops/publish" && method === "GET") {
      return await publishOverviewRoute(deps.data, ids);
    }
    if (decision.pattern === "/ops/publish/preview" && method === "GET") {
      return await publishPreviewRoute(deps.data, ids);
    }
    if (
      decision.pattern === "/ops/publish/rollback-preview" &&
      method === "GET"
    ) {
      return await rollbackPreviewRoute(event, deps.data, ids);
    }
    if (decision.pattern === "/ops/publish/jobs/{id}" && method === "GET") {
      return await publishJobRoute(decision.params.id ?? "", deps.data, ids);
    }
    if (principal.kind === "operator" && method === "POST") {
      if (decision.pattern === "/ops/publish/jobs") {
        return await createPublishJobRoute(event, principal, deps.data, ids);
      }
      if (decision.pattern === "/ops/publish/holds/{id}/reapply") {
        return await reapplyNoticeRoute(
          event,
          decision.params.id ?? "",
          principal,
          deps.data,
          ids,
        );
      }
    }
    if (
      decision.pattern === "/ops/account/mfa-reset" &&
      method === "POST" &&
      principal.kind === "operator"
    ) {
      return await mfaResetRoute(event, principal, deps.data, ids);
    }
    if (decision.pattern === "/ops/inquiries/{id}") {
      const id = decision.params.id ?? "";
      if (method === "GET") {
        return await detailRoute(id, principal, deps.data, ids);
      }
      if (method === "PATCH" && principal.kind === "operator") {
        return await patchRoute(event, id, principal, deps.data, ids);
      }
    }
    // 허용표에는 있지만 처리가 없는 경로(표와 코드가 어긋남)
    return errorJson(404, "not_found", ids);
  } catch (error) {
    safeLog("error", "ops_failed", {
      path,
      method,
      traceId: ids.traceId,
      error: error instanceof Error ? error.name : "unknown",
    });
    return errorJson(500, "internal", ids);
  }
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`환경 변수 없음: ${name}`);
  return value;
}

// 경보 접두어(스택 이름-)는 infra가 넣음. 없으면 경보만 '확인 못 함'(수집 현황의 다른 값은 그대로)
function alarmReader(): AlarmReader | null {
  const prefix = process.env.OPS_ALARM_PREFIX;
  const region = process.env.AWS_REGION;
  return prefix && region ? cloudWatchAlarmReader(region, prefix) : null;
}

// 인증키 태그 읽기. 지역이 없으면 키만 '확인 못 함'
function keyTagReader(): ApiKeyTags | null {
  const region = process.env.AWS_REGION;
  return region ? ssmKeyTagReader(region) : null;
}

// 게시 버킷(publisher와 같은 SNAPSHOT_BUCKET, infra가 이름과 data/ 읽기·목록 권한을 줌). 이름이 없으면 상태만 '확인 못 함'
function snapshotReader(): SnapshotStore | null {
  const bucket = process.env.SNAPSHOT_BUCKET;
  return bucket ? new S3SnapshotStore(new S3Client({}), bucket) : null;
}

// publisher 함수(infra가 이름과 그 함수 하나의 InvokeFunction 권한을 줌). 비동기(Event)로만 부름
// 202가 아니면 던짐 → 작업은 invoke_failed. 이름이 없으면 null(작업을 만들지 않음)
function publisherInvoker(): PublisherInvoker | null {
  const functionName = process.env.PUBLISHER_FUNCTION_NAME;
  if (!functionName) return null;
  const lambda = new LambdaClient({});
  return {
    async invoke(payload) {
      const result = await lambda.send(
        new InvokeCommand({
          FunctionName: functionName,
          InvocationType: "Event",
          Payload: new TextEncoder().encode(JSON.stringify(payload)),
        }),
      );
      if (result.StatusCode !== 202) {
        throw new Error(`publisher 호출 상태 ${result.StatusCode}`);
      }
    },
    // 미리보기는 따로 둔 읽기 전용 함수를 동기(RequestResponse)로 부름(게시 함수의 실행·오류 수에 섞이지 않게)
    // 함수 이름이 없거나 함수 오류(FunctionError)면 던짐 → 화면은 '미리보기를 만들지 못했어요'
    async preview() {
      const previewName = process.env.PREVIEW_FUNCTION_NAME;
      if (!previewName) throw new Error("미리보기 함수 이름 없음");
      const result = await lambda.send(
        new InvokeCommand({
          FunctionName: previewName,
          InvocationType: "RequestResponse",
          Payload: new TextEncoder().encode("{}"),
        }),
        { abortSignal: AbortSignal.timeout(PREVIEW_WAIT_MS) },
      );
      if (result.FunctionError || !result.Payload) {
        throw new Error(
          `미리보기 함수 오류 ${result.FunctionError ?? "빈 응답"}`,
        );
      }
      return JSON.parse(new TextDecoder().decode(result.Payload)) as unknown;
    },
  };
}

function statsReader(now: () => Date): StatsReader | null {
  const propertyId = process.env.GA4_PROPERTY_ID;
  const serviceAccountParam = process.env.GA4_SERVICE_ACCOUNT_PARAM;
  const region = process.env.AWS_REGION;
  if (!propertyId || !serviceAccountParam || !region) return null;
  return createCachedStatsReader(
    createGa4StatsReader({ propertyId, serviceAccountParam, region, now }),
    now,
  );
}

let runtime: OpsDependencies | undefined;

function runtimeDependencies(): OpsDependencies {
  if (runtime) return runtime;
  const config = {
    operator: {
      userPoolId: requiredEnv("OPERATOR_USER_POOL_ID"),
      clientId: requiredEnv("OPERATOR_CLIENT_ID"),
    },
    sample: {
      userPoolId: requiredEnv("SAMPLE_USER_POOL_ID"),
      clientId: requiredEnv("SAMPLE_CLIENT_ID"),
    },
  };
  const opsTable = requiredEnv("OPS_TABLE_NAME");
  const inquiryTable = requiredEnv("INQUIRY_TABLE_NAME");
  const client = DynamoDBDocumentClient.from(new DynamoDBClient({}));
  const now = () => new Date();
  runtime = {
    auth: {
      config,
      verifier: createTokenVerifier(config),
      samplePolicy: () => readSamplePolicy(client, opsTable),
      now,
    },
    data: {
      client,
      opsTable,
      inquiryTable,
      now,
      alarms: alarmReader(),
      keys: keyTagReader(),
      snapshots: snapshotReader(),
      publisher: publisherInvoker(),
      mfaReset: cognitoMfaResetter(config.operator.userPoolId),
      stats: statsReader(now),
    },
  };
  return runtime;
}

export async function opsHandler(
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyStructuredResultV2> {
  return handleOps(event, runtimeDependencies());
}
