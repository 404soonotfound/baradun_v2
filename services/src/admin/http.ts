import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyStructuredResultV2,
} from "aws-lambda";
import { randomUUID } from "node:crypto";

// 운영 API 응답 공통 (D16-B7, 구현 제안 I05)
// - 모든 응답 no-store(인증이 필요한 응답을 브라우저·중간 캐시에 남기지 않음)
// - 오류 본문: { error: { code, requestId, traceId } }. 문구는 관리자 앱이 code로 정함
//   requestId = "req-" + 8자(화면에 보여 주는 짧은 번호, 전역 유일 키 아님), traceId = 전체 ID(응답·로그)

export interface RequestIds {
  readonly traceId: string;
  readonly requestId: string;
}

export function newRequestIds(): RequestIds {
  const traceId = randomUUID();
  return {
    traceId,
    requestId: `req-${traceId.replaceAll("-", "").slice(0, 8)}`,
  };
}

export function header(
  event: APIGatewayProxyEventV2,
  name: string,
): string | undefined {
  const wanted = name.toLowerCase();
  return Object.entries(event.headers ?? {}).find(
    ([key]) => key.toLowerCase() === wanted,
  )?.[1];
}

const HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
} as const;

export function json(
  statusCode: number,
  body: unknown,
  ids: RequestIds,
): APIGatewayProxyStructuredResultV2 {
  return {
    statusCode,
    headers: { ...HEADERS, "x-request-id": ids.traceId },
    body: JSON.stringify(body),
  };
}

export type ErrorCode =
  | "missing_token"
  | "invalid_token"
  | "session_expired"
  | "role_unclear"
  | "sample_not_allowed"
  | "forbidden"
  | "not_found"
  | "method_not_allowed"
  | "conflict"
  | "internal";

export function errorJson(
  statusCode: number,
  code: ErrorCode,
  ids: RequestIds,
): APIGatewayProxyStructuredResultV2 {
  return json(
    statusCode,
    { error: { code, requestId: ids.requestId, traceId: ids.traceId } },
    ids,
  );
}

// 토큰·이메일·본문은 남기지 않음. 정해 둔 필드만
export function safeLog(
  level: "info" | "warn" | "error",
  event: string,
  fields: Record<string, string | number> = {},
): void {
  console.log(JSON.stringify({ level, event, ...fields }));
}
