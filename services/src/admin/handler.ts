import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyStructuredResultV2,
} from "aws-lambda";
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
  decodeCursor,
  getInquiry,
  INQUIRY_PAGE_DEFAULT,
  INQUIRY_PAGE_MAX,
  inquiryPatchFields,
  listInquiries,
  parseInquiryPatch,
} from "./inquiries";
import {
  ACCESS_TOKEN_HEADER,
  IDEMPOTENCY_KEY,
  IDEMPOTENCY_KEY_HEADER,
  OPS_SESSION_MAX_MS,
} from "./policy";
import { decideRoute } from "./routes";
import { readSamplePolicy } from "./sample";
import { sampleInquiry, sampleInquiryPage } from "./sample-data";
import { payloadHashOf, versionedWrite, type Sender } from "./writes";
import { INQUIRY_STATUSES, type InquiryStatus } from "../inquiry/policy";

// 운영 API 단일 함수 /ops/* (D16-B1·E4). 입구는 관리자 사이트 CloudFront + OAC + 함수 URL(BRD-147에서 연결)
// 순서: 요청 ID → 토큰 검증(역할·샘플 허용) → 허용표 → 업무 처리
// 업무 경로가 늘면 handle의 분기만 더함. 인증·허용표를 건너뛰는 경로는 두지 않음

export interface DataDependencies {
  readonly client: Sender;
  readonly opsTable: string;
  readonly inquiryTable: string;
  readonly now: () => Date;
}

export interface OpsDependencies {
  readonly auth: AuthDependencies;
  readonly data: DataDependencies;
  readonly ids?: () => RequestIds;
}

const INQUIRY_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

type Result = APIGatewayProxyStructuredResultV2;

function isStatus(value: unknown): value is InquiryStatus {
  return (
    typeof value === "string" &&
    (INQUIRY_STATUSES as readonly string[]).includes(value)
  );
}

// GET /ops/inquiries?status=&cursor=&limit=
async function listRoute(
  event: APIGatewayProxyEventV2,
  principal: Principal,
  data: DataDependencies,
  ids: RequestIds,
): Promise<Result> {
  const params = event.queryStringParameters ?? {};
  const status = params.status;
  if (status !== undefined && !isStatus(status)) {
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
  if (cursor === null || (cursor && status && cursor.s !== status)) {
    return errorJson(400, "invalid_request", ids, { field: "cursor" });
  }
  if (principal.kind === "sample") {
    return json(200, sampleInquiryPage(status, data.now()), ids);
  }
  const page = await listInquiries(
    data.client,
    data.inquiryTable,
    { ...(status ? { status } : {}), ...(cursor ? { cursor } : {}), limit },
    data.now(),
  );
  return json(200, page, ids);
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

// PATCH /ops/inquiries/{id}: 처리 상태·반려 이유·내부 메모 (D16-D5·D6, B6)
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
    data: { client, opsTable, inquiryTable, now },
  };
  return runtime;
}

export async function opsHandler(
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyStructuredResultV2> {
  return handleOps(event, runtimeDependencies());
}
