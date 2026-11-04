import {
  exposeProblems,
  sameContent,
  type NoticeContent,
  type NoticeView,
} from "../notices";
import type { OpsRequest, OpsResult } from "./ops-fetch";

// 로컬 테스트 로그인용 예시 공지 (BRD-151). local-dev.ts가 불러와 개발 서버에서만 씀(배포 빌드에서 빠짐)
// 서버(services/src/admin/notice-routes.ts)처럼 version이 다르면 409, 확정 전 검사, 노출 중 삭제 거부
// 이 탭 메모리에서만 바뀜(새로고침하면 처음으로)

interface Example {
  id: string;
  version: number;
  draft: NoticeContent;
  live: NoticeContent | null;
  exposedAt: string | null;
  updatedAt: string;
  deletedAt: string | null;
}

const at = (hours: number) =>
  new Date(Date.now() + hours * 3_600_000).toISOString();

const text = (ko: string, en: string) => ({ ko, en });

function examples(): Example[] {
  const maintenance: NoticeContent = {
    kind: "maintenance_notice",
    title: text("(로컬 예시) 새벽 점검 예고", "(Local) Planned maintenance"),
    body: text(
      "(로컬 예시) 새벽 2시~4시에 해변 정보가 늦게 바뀔 수 있어요.",
      "(Local) Beach info may update late from 2 to 4 a.m.",
    ),
    startsAt: at(-3),
    endsAt: at(20),
  };
  const general: NoticeContent = {
    kind: "general",
    title: text("(로컬 예시) 데이터 출처 안내", "(Local) Data sources"),
    body: text(
      "(로컬 예시) 데이터 출처 안내가 바뀌었어요.",
      "(Local) We updated the data sources page.",
    ),
    startsAt: at(-1),
    endsAt: at(48),
  };
  return [
    {
      id: "n-local-live",
      version: 3,
      draft: { ...maintenance, endsAt: at(22) },
      live: maintenance,
      exposedAt: at(-4),
      updatedAt: at(-1),
      deletedAt: null,
    },
    {
      id: "n-local-hidden",
      version: 2,
      draft: general,
      live: general,
      exposedAt: at(-2),
      updatedAt: at(-2),
      deletedAt: null,
    },
    {
      id: "n-local-scheduled",
      version: 2,
      draft: {
        ...general,
        title: text("(로컬 예시) 해변 추가 예정", "(Local) More beaches soon"),
        startsAt: at(30),
        endsAt: null,
      },
      live: {
        ...general,
        title: text("(로컬 예시) 해변 추가 예정", "(Local) More beaches soon"),
        startsAt: at(30),
        endsAt: null,
      },
      exposedAt: at(-5),
      updatedAt: at(-5),
      deletedAt: null,
    },
    {
      id: "n-local-draft",
      version: 1,
      draft: {
        ...general,
        title: text("(로컬 예시) 영어 문구를 아직 안 씀", ""),
        body: text("(로컬 예시) 확정하려면 영어 문구가 필요해요.", ""),
        startsAt: at(5),
        endsAt: at(72),
      },
      live: null,
      exposedAt: null,
      updatedAt: at(-6),
      deletedAt: null,
    },
    {
      id: "n-local-ended",
      version: 4,
      draft: { ...general, startsAt: at(-100), endsAt: at(-50) },
      live: { ...general, startsAt: at(-100), endsAt: at(-50) },
      exposedAt: at(-101),
      updatedAt: at(-50),
      deletedAt: null,
    },
  ];
}

let store: Example[] | null = null;
const notices = () => (store ??= examples());

function state(e: Example, now: number): NoticeView["state"] {
  if (e.live === null) return "draft";
  if (Date.parse(e.live.startsAt) > now) return "scheduled";
  if (e.live.endsAt !== null && Date.parse(e.live.endsAt) <= now) {
    return "ended";
  }
  return "live";
}

function views(now: number): NoticeView[] {
  const alive = notices().filter((e) => e.deletedAt === null);
  // 한 자리 규칙(D16-D4): 점검 예고 > 일반, 같은 종류는 시작이 늦은 공지, 같으면 ID 순
  const shown = alive
    .filter((e) => state(e, now) === "live")
    .sort((a, b) =>
      a.live!.kind !== b.live!.kind
        ? a.live!.kind === "maintenance_notice"
          ? -1
          : 1
        : Date.parse(b.live!.startsAt) - Date.parse(a.live!.startsAt) ||
          (a.id < b.id ? -1 : 1),
    )[0]?.id;
  return alive
    .map((e) => {
      const s = state(e, now);
      return {
        id: e.id,
        version: e.version,
        draft: e.draft,
        live: e.live,
        exposedAt: e.exposedAt,
        updatedAt: e.updatedAt,
        state: s,
        pendingEdit: e.live !== null && !sameContent(e.draft, e.live),
        hidden: s === "live" && e.id !== shown,
      };
    })
    .sort(
      (a, b) => Date.parse(b.draft.startsAt) - Date.parse(a.draft.startsAt),
    );
}

const fail = <T>(
  status: number,
  code: string,
  extra: { reason?: string; field?: string } = {},
): OpsResult<T> => ({ ok: false, status, code, requestId: null, ...extra });

const done = <T>(e: Example, status = 200): OpsResult<T> => ({
  ok: true,
  status,
  body: { noticeId: e.id, version: e.version } as T,
});

export function localNotices<T>(
  path: string,
  request: OpsRequest,
): OpsResult<T> | null {
  const method = request.method ?? "GET";
  const now = Date.now();
  if (path === "/ops/notices") {
    if (method === "GET") {
      return { ok: true, status: 200, body: { items: views(now) } as T };
    }
    if (method === "POST") {
      const e: Example = {
        id: `n-local-${crypto.randomUUID().slice(0, 8)}`,
        version: 1,
        draft: request.body as NoticeContent,
        live: null,
        exposedAt: null,
        updatedAt: new Date(now).toISOString(),
        deletedAt: null,
      };
      notices().push(e);
      return done(e, 201);
    }
  }
  const match = /^\/ops\/notices\/([^/]+)(\/(expose|end))?$/.exec(path);
  if (!match) return null;
  const e = notices().find(
    (x) => x.id === decodeURIComponent(match[1]!) && x.deletedAt === null,
  );
  if (!e) return fail(404, "not_found");
  const body = request.body as { version: number } & Partial<NoticeContent>;
  if (body.version !== e.version) {
    return fail(409, "conflict", { reason: "version" });
  }
  const action = match[3] ?? method;
  const s = state(e, now);
  if (action === "PUT") {
    e.draft = {
      kind: body.kind!,
      title: body.title!,
      body: body.body!,
      startsAt: body.startsAt!,
      endsAt: body.endsAt ?? null,
    };
  } else if (action === "expose") {
    const problem = exposeProblems(e.draft, now)[0];
    if (problem) return fail(400, "invalid_request", problem);
    e.live = e.draft;
    e.exposedAt = new Date(now).toISOString();
  } else if (action === "end") {
    if (s === "scheduled") e.live = null;
    else if (s === "live") {
      const endsAt = new Date(now).toISOString();
      e.live = { ...e.live!, endsAt };
      if (Date.parse(e.draft.startsAt) < now) e.draft = { ...e.draft, endsAt };
    } else return fail(409, "conflict", { reason: "not_live" });
  } else if (action === "DELETE") {
    if (s === "live") return fail(409, "conflict", { reason: "live" });
    e.deletedAt = new Date(now).toISOString();
  } else {
    return null;
  }
  e.version += 1;
  e.updatedAt = new Date(now).toISOString();
  return done(e);
}
