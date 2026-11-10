import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
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
import { readCollection } from "./collection";
import { cloudWatchAlarmReader, type AlarmReader } from "./collection-alarms";
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
import { decideRoute, matchRoute } from "./routes";
import { readSamplePolicy } from "./sample";
import { sampleInquiry, sampleInquiryPage } from "./sample-data";
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
    if (decision.pattern === "/ops/audit" && method === "GET") {
      return await auditRoute(event, deps.data, ids);
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
    data: { client, opsTable, inquiryTable, now, alarms: alarmReader() },
  };
  return runtime;
}

export async function opsHandler(
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyStructuredResultV2> {
  return handleOps(event, runtimeDependencies());
}
