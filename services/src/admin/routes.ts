import type { Principal } from "./auth";
import type { OperatorRole } from "./policy";

// 역할별 endpoint·method 허용표 (구현 제안 I04). 서버가 원본이고 화면의 버튼 숨김은 안내일 뿐
// - 표에 없는 경로는 404, 경로는 있으나 method가 없으면 405
// - 샘플은 sample: true인 GET만. 쓰기 method에는 sample을 둘 수 없음(아래 검사)
// - 판단 상태(status)를 쓰는 경로는 두지 않음(G1). 운영 API 역할에는 State 테이블 권한도 없음
// - 업무 경로(공지·문의·메모·게시)는 각 이슈에서 이 표에 더함
// - 경로의 {이름} 자리는 "/" 없는 한 칸과 맞고 params로 돌려줌. 값의 형식 검사는 업무 처리에서 함

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
  // 문의 목록·상세(BRD-153). 보기 권한은 본문·메모를 받지 않음, 샘플은 예시 문의
  "/ops/inquiries": {
    GET: { roles: ["viewer", "editor", "publisher"], sample: true },
  },
  "/ops/inquiries/{id}": {
    GET: { roles: ["viewer", "editor", "publisher"], sample: true },
    // 처리 상태·반려 이유·내부 메모(편집 이상)
    PATCH: { roles: ["editor", "publisher"], sample: false },
  },
};

export type RouteDecision =
  | {
      readonly ok: true;
      readonly pattern: string;
      readonly params: Readonly<Record<string, string>>;
    }
  | { readonly ok: false; readonly status: 403 | 404 | 405 };

// 표의 경로 모양과 실제 경로를 칸별로 맞춤. 고정 경로가 자리 경로보다 먼저
export function matchRoute(
  path: string,
): { pattern: string; params: Record<string, string> } | undefined {
  if (ROUTES[path]) return { pattern: path, params: {} };
  const parts = path.split("/");
  for (const pattern of Object.keys(ROUTES)) {
    const want = pattern.split("/");
    if (want.length !== parts.length) continue;
    const params: Record<string, string> = {};
    const ok = want.every((seg, i) => {
      const part = parts[i]!;
      if (seg.startsWith("{") && seg.endsWith("}")) {
        if (part === "") return false;
        params[seg.slice(1, -1)] = decodeURIComponent(part);
        return true;
      }
      return seg === part;
    });
    if (ok) return { pattern, params };
  }
  return undefined;
}

export function isWriteMethod(method: Method): boolean {
  return method !== "GET";
}

export function decideRoute(
  path: string,
  method: string,
  principal: Principal,
): RouteDecision {
  let matched: ReturnType<typeof matchRoute>;
  try {
    matched = matchRoute(path);
  } catch {
    // 잘못된 % 인코딩(decodeURIComponent 실패)은 없는 경로로 봄
    return { ok: false, status: 404 };
  }
  if (!matched) return { ok: false, status: 404 };
  const rule = ROUTES[matched.pattern]![method as Method];
  if (!rule) return { ok: false, status: 405 };
  const ok = { ok: true, ...matched } as const;
  if (principal.kind === "sample") {
    // 샘플은 모든 쓰기 거절(D16-A8). 표가 잘못돼도 쓰기는 막음
    return rule.sample && !isWriteMethod(method as Method)
      ? ok
      : { ok: false, status: 403 };
  }
  return rule.roles.includes(principal.role) ? ok : { ok: false, status: 403 };
}
