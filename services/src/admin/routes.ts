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
  // 공지(BRD-151, ADM-NTC). 문구 저장은 편집, 노출·노출 끝내기는 노출 변경(D16-D4)
  // 샘플은 목록만, 예시 공지로 받음(공개 전 문구를 보이지 않게)
  "/ops/notices": {
    GET: { roles: ["viewer", "editor", "publisher"], sample: true },
    POST: { roles: ["editor", "publisher"], sample: false },
  },
  "/ops/notices/{id}": {
    PUT: { roles: ["editor", "publisher"], sample: false },
    // 예약된 노출본이 있는 공지는 노출 변경만 지울 수 있음(처리에서 다시 확인)
    DELETE: { roles: ["editor", "publisher"], sample: false },
  },
  "/ops/notices/{id}/expose": {
    POST: { roles: ["publisher"], sample: false },
  },
  "/ops/notices/{id}/end": {
    POST: { roles: ["publisher"], sample: false },
  },
  // 수집 현황(BRD-149, ADM-COLLECT). 수집 실행 기록만 읽음. 개인정보가 없어 샘플도 받음
  "/ops/collection": {
    GET: { roles: ["viewer", "editor", "publisher"], sample: true },
  },
  // 데이터 출처(BRD-149 ADM-SRC). 읽기 전용. 인증키는 등록 여부·만료일만
  "/ops/sources": {
    GET: { roles: ["viewer", "editor", "publisher"], sample: true },
  },
  // 해변 관리(BRD-150, ADM-BCH). 해변 정보는 저장소 파일이 원본이라 운영 API에 없음(빌드 때 화면에 들어감)
  // 지금 표시 상태: 게시본 status.json의 분류·사유 그대로(읽기만, G1). 공개 게시본과 같은 값이라 샘플도 받음
  // 경로 이름에 status를 쓰지 않음(판단 상태를 쓰는 경로가 없음을 확인하는 검사가 이름으로 막음)
  "/ops/beaches/published": {
    GET: { roles: ["viewer", "editor", "publisher"], sample: true },
  },
  // 해변별 운영 메모(내부용). 저장은 편집 이상, 샘플은 읽기도 받지 않음(실제 운영 메모를 보이지 않게)
  "/ops/beaches/{id}/memo": {
    GET: { roles: ["viewer", "editor", "publisher"], sample: false },
    PUT: { roles: ["editor", "publisher"], sample: false },
  },
  // 데이터 게시(#331, ADM-PUB). 보기는 모든 역할, 지금 게시·되돌리기·다시 적용은 노출 변경만(아키텍처 18.2)
  // 샘플은 받지 않음: 대기·되돌림 공지에 공개 전 문구가 있음(사용자 결정 2026-11-12)
  // 판단 상태를 바꾸는 경로가 아님(게시는 publisher가 마지막 수집 사실로 분류함, G1)
  "/ops/publish": {
    GET: { roles: ["viewer", "editor", "publisher"], sample: false },
  },
  // 지금 게시 변경 미리보기(캔버스 N2). 분류는 미리보기 전용 함수가 publisher 코드로 계산, 쓰기 없음. 샘플은 받지 않음
  "/ops/publish/preview": {
    GET: { roles: ["viewer", "editor", "publisher"], sample: false },
  },
  // 되돌리기 확인 창의 영향 목록(읽기만). 공개 전 공지 제목이 있어 샘플은 받지 않음
  "/ops/publish/rollback-preview": {
    GET: { roles: ["viewer", "editor", "publisher"], sample: false },
  },
  "/ops/publish/jobs": {
    POST: { roles: ["publisher"], sample: false },
  },
  "/ops/publish/jobs/{id}": {
    GET: { roles: ["viewer", "editor", "publisher"], sample: false },
  },
  "/ops/publish/holds/{id}/reapply": {
    POST: { roles: ["publisher"], sample: false },
  },
  // 변경 이력(BRD-155). 읽기 전용, 샘플은 받지 않음(D15-3)
  "/ops/audit": {
    GET: { roles: ["viewer", "editor", "publisher"], sample: false },
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
