import type { Principal } from "./auth";
import type { OperatorRole } from "./policy";

// 역할별 endpoint·method 허용표 (구현 제안 I04). 서버가 원본이고 화면의 버튼 숨김은 안내일 뿐
// - 표에 없는 경로는 404, 경로는 있으나 method가 없으면 405
// - 샘플은 sample: true인 GET만. 쓰기 method에는 sample을 둘 수 없음(아래 검사)
// - 판단 상태(status)를 쓰는 경로는 두지 않음(G1). 운영 API 역할에는 State 테이블 권한도 없음
// - 업무 경로(공지·문의·메모·게시)는 각 이슈에서 이 표에 더함

export type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface RouteRule {
  readonly roles: readonly OperatorRole[];
  readonly sample: boolean;
}

export const ROUTES: Readonly<
  Record<string, Partial<Record<Method, RouteRule>>>
> = {
  // 로그인한 계정의 역할·세션 확인(관리자 앱 시작 때 부름)
  "/ops/me": {
    GET: { roles: ["viewer", "editor", "publisher"], sample: true },
  },
};

export type RouteDecision =
  | { readonly ok: true }
  | { readonly ok: false; readonly status: 403 | 404 | 405 };

export function isWriteMethod(method: Method): boolean {
  return method !== "GET";
}

export function decideRoute(
  path: string,
  method: string,
  principal: Principal,
): RouteDecision {
  const route = ROUTES[path];
  if (!route) return { ok: false, status: 404 };
  const rule = route[method as Method];
  if (!rule) return { ok: false, status: 405 };
  if (principal.kind === "sample") {
    // 샘플은 모든 쓰기 거절(D16-A8). 표가 잘못돼도 쓰기는 막음
    return rule.sample && !isWriteMethod(method as Method)
      ? { ok: true }
      : { ok: false, status: 403 };
  }
  return rule.roles.includes(principal.role)
    ? { ok: true }
    : { ok: false, status: 403 };
}
