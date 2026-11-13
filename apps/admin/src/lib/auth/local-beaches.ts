import type { OpsRequest, OpsResult } from "./ops-fetch";

// 로컬 테스트 로그인용 해변 관리 예시 (BRD-150). local-dev.ts가 불러와 개발 서버에서만 씀(배포 빌드에서 빠짐)
// - 지금 표시 상태: 예시 해변 몇 곳만 게시본에 둠. 나머지는 '게시본에 해변 정보가 없어요'로 보임
// - 운영 메모: 서버(services/src/admin/beaches.ts)처럼 version이 다르면 409. 이 탭 메모리에서만 바뀜

const at = (minutes: number) =>
  new Date(Date.now() + minutes * 60_000).toISOString();

export function localPublishedView() {
  const validUntil = at(41);
  return {
    available: true,
    snapshotVersion: "20261111T030000Z",
    generatedAt: at(-4),
    maintenance: { active: false, until: null },
    beaches: {
      b0001: { category: "clear", reasons: [], validUntil },
      b0002: {
        category: "unavailable",
        validUntil,
        reasons: [
          {
            code: "warning",
            type: "wind_wave",
            level: "advisory",
            scope: "강원중부앞바다",
            source: "기상청",
            at: at(-60),
          },
        ],
      },
      b0003: {
        category: "undetermined",
        validUntil,
        reasons: [
          {
            code: "warning_unknown",
            scope: "강원중부앞바다",
            source: "기상청",
            at: null,
          },
        ],
      },
      b0004: {
        category: "undetermined",
        validUntil,
        reasons: [
          {
            code: "observation_delayed",
            scope: "연곡 파고부이",
            source: "기상청",
            at: at(-130),
          },
        ],
      },
      b0005: { category: "clear", reasons: [], validUntil },
    },
  };
}

interface Memo {
  memo: string | null;
  version: number;
  updatedAt: string | null;
}

const memos = new Map<string, Memo>([
  [
    "b0001",
    {
      memo: "(로컬 예시) 주차장 공사로 현장 안내판 위치가 바뀜",
      version: 1,
      updatedAt: at(-90),
    },
  ],
]);

export function localBeaches<T>(
  pathname: string,
  request: OpsRequest,
): OpsResult<T> | null {
  const method = request.method ?? "GET";
  if (method === "GET" && pathname === "/ops/beaches/published") {
    return { ok: true, status: 200, body: localPublishedView() as T };
  }
  const match = /^\/ops\/beaches\/([^/]+)\/memo$/.exec(pathname);
  if (!match) return null;
  const id = decodeURIComponent(match[1]!);
  const current = memos.get(id) ?? { memo: null, version: 0, updatedAt: null };
  if (method === "GET") {
    return { ok: true, status: 200, body: { beachId: id, ...current } as T };
  }
  if (method === "PUT") {
    const body = request.body as { version: number; memo: string | null };
    if (body.version !== current.version) {
      return {
        ok: false,
        status: 409,
        code: "conflict",
        requestId: "req-local409",
        reason: "version",
      };
    }
    const next = {
      memo: body.memo,
      version: current.version + 1,
      updatedAt: new Date().toISOString(),
    };
    memos.set(id, next);
    return {
      ok: true,
      status: 200,
      body: { beachId: id, version: next.version } as T,
    };
  }
  return null;
}
