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
  safeLog,
  type ErrorCode,
  type RequestIds,
} from "./http";
import { ACCESS_TOKEN_HEADER, OPS_SESSION_MAX_MS } from "./policy";
import { decideRoute } from "./routes";
import { readSamplePolicy } from "./sample";

// 운영 API 단일 함수 /ops/* (D16-B1·E4). 입구는 관리자 사이트 CloudFront + OAC + 함수 URL(BRD-147에서 연결)
// 순서: 요청 ID → 토큰 검증(역할·샘플 허용) → 허용표 → 업무 처리
// 업무 경로가 늘면 handle의 분기만 더함. 인증·허용표를 건너뛰는 경로는 두지 않음

export interface OpsDependencies {
  readonly auth: AuthDependencies;
  readonly ids?: () => RequestIds;
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

    if (path === "/ops/me" && method === "GET") {
      return json(200, meBody(auth.principal), ids);
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
  const tableName = requiredEnv("OPS_TABLE_NAME");
  const client = DynamoDBDocumentClient.from(new DynamoDBClient({}));
  runtime = {
    auth: {
      config,
      verifier: createTokenVerifier(config),
      samplePolicy: () => readSamplePolicy(client, tableName),
      now: () => new Date(),
    },
  };
  return runtime;
}

export async function opsHandler(
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyStructuredResultV2> {
  return handleOps(event, runtimeDependencies());
}
