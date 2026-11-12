import type {
  JobView,
  PreviewAnswer,
  PublishOverview,
  RollbackPreview,
} from "../publish";
import type { OpsRequest, OpsResult } from "./ops-fetch";

// 로컬 테스트 로그인용 예시 데이터 게시 (#331). local-dev.ts가 불러와 개발 서버에서만 씀(배포 빌드에서 빠짐)
// 서버(services/src/admin/publish-routes.ts)처럼 작업은 대기 → 실행 → 게시 완료로 바뀜(읽을 때마다 한 단계)
// 이 탭 메모리에서만 바뀜(새로고침하면 처음으로). 실제 운영 API·publisher는 부르지 않음

const MINUTE = 60_000;
const iso = (ms: number) => new Date(ms).toISOString().replace(".000Z", "Z");
const version = (ms: number) =>
  iso(ms).replace(/[-:]/g, "").replace(/\.\d+/, "");
// 10분 단위로 맞춘 기준 시각(예시 게시 시각이 매번 같은 자리)
const base = Math.floor(Date.now() / (10 * MINUTE)) * 10 * MINUTE;

const versions = [0, 10, 20, 30, 40].map((m) => version(base - m * MINUTE));

let job: JobView | null = null;
let held = {
  version: 1,
  items: [
    {
      id: "n-local-held01",
      title: "(로컬 예시) 해변 운영 시간 안내",
      target: versions[3]!,
      at: iso(base - 25 * MINUTE),
      restoresLive: false,
    },
  ],
};

function overview(): PublishOverview {
  const now = Date.now();
  const next = (period: number, offset: number) => {
    const slot =
      Math.floor((now - offset * MINUTE) / (period * MINUTE)) *
        period *
        MINUTE +
      offset * MINUTE;
    return new Date(slot + period * MINUTE).toISOString();
  };
  const counts = { clear: 180, unavailable: 23, undetermined: 3 };
  return {
    current: { ok: true, version: versions[0]!, generatedAt: iso(base) },
    history: {
      ok: true,
      items: [
        {
          result: "published",
          version: versions[0]!,
          at: iso(base),
          source: "auto",
          beachCount: 206,
          changes: {
            notices: false,
            categoryCounts: counts,
            categoryDelta: { clear: -3, unavailable: 3, undetermined: 0 },
            delayedBeaches: 1,
            delayedDelta: 0,
          },
          gapBefore: false,
        },
        {
          result: "published",
          version: versions[1]!,
          at: iso(base - 10 * MINUTE),
          source: "operator",
          beachCount: 206,
          changes: {
            notices: true,
            categoryCounts: { clear: 183, unavailable: 20, undetermined: 3 },
            categoryDelta: { clear: 0, unavailable: 0, undetermined: 0 },
            delayedBeaches: 1,
            delayedDelta: 0,
          },
          gapBefore: false,
        },
        {
          result: "failed",
          version: versions[2]!,
          at: iso(base - 20 * MINUTE),
          source: "auto",
          reason: "beach_ids",
        },
        {
          result: "published",
          version: versions[3]!,
          at: iso(base - 30 * MINUTE),
          source: "auto",
          beachCount: 206,
          changes: null,
          gapBefore: false,
        },
      ],
    },
    lastRun: {
      ok: true,
      run: {
        at: iso(base + 5 * MINUTE),
        source: "auto",
        result: "unchanged",
        version: versions[0]!,
      },
    },
    nextAuto: { warnings: next(15, 3), observations: next(30, 10) },
    pendingNotices: {
      ok: true,
      maintenancePending: false,
      items: [
        {
          id: "n-local-maint",
          change: "update",
          kind: "maintenance_notice",
          title: "(로컬 예시) 새벽 점검 예고",
          startsAt: iso(base - 3 * 60 * MINUTE),
          endsAt: iso(base + 20 * 60 * MINUTE),
        },
        {
          id: "n-local-new",
          change: "add",
          kind: "general",
          title: "(로컬 예시) 데이터 출처 안내",
          startsAt: iso(base - 60 * MINUTE),
          endsAt: null,
        },
      ],
    },
    heldNotices: { ok: true, ...held },
    latestJob: { ok: true, job },
  };
}

// 읽을 때마다 한 단계씩 진행(대기 → 실행 → 게시 완료)
function advance(current: JobView): JobView {
  const now = iso(Date.now());
  if (current.state === "pending") {
    return { ...current, state: "running", startedAt: now };
  }
  if (current.state === "running") {
    return {
      ...current,
      state: "done",
      result: "published",
      snapshotVersion: version(Date.now()),
      finishedAt: now,
    };
  }
  return current;
}

const ok = <T>(body: unknown, status = 200): OpsResult<T> => ({
  ok: true,
  status,
  body: body as T,
});

export function localPublish<T>(
  pathname: string,
  search: URLSearchParams,
  request: OpsRequest,
): OpsResult<T> | null {
  const method = request.method ?? "GET";
  if (method === "GET" && pathname === "/ops/publish") {
    return ok<T>(overview());
  }
  if (method === "GET" && pathname === "/ops/publish/preview") {
    const answer: PreviewAnswer = {
      ok: true,
      preview: {
        status: "ready",
        at: iso(Date.now()),
        current: {
          version: versions[0]!,
          counts: { clear: 180, unavailable: 23, undetermined: 3 },
          readable: true,
          missing: false,
        },
        next: { counts: { clear: 179, unavailable: 24, undetermined: 3 } },
        changed: [
          {
            id: "b0001",
            before: { category: "clear", reasons: [] },
            after: {
              category: "unavailable",
              reasons: [
                { code: "warning", type: "wind_wave", level: "advisory" },
              ],
            },
          },
        ],
        changedCount: 1,
        checks: { beachIds: null, expected: 206, contractErrors: 0 },
      },
    };
    return ok<T>(answer);
  }
  if (method === "GET" && pathname === "/ops/publish/rollback-preview") {
    const target = search.get("version") ?? "";
    const answer: RollbackPreview =
      target === versions[3]
        ? {
            available: true,
            version: target,
            items: [
              {
                id: "n-local-maint",
                change: "restore",
                title: "(로컬 예시) 새벽 점검 예고",
              },
            ],
          }
        : { available: false, version: target };
    return ok<T>(answer);
  }
  const jobPath = /^\/ops\/publish\/jobs\/([^/]+)$/.exec(pathname);
  if (method === "GET" && jobPath) {
    if (!job || job.jobId !== decodeURIComponent(jobPath[1]!)) {
      return { ok: false, status: 404, code: "not_found", requestId: null };
    }
    job = advance(job);
    return ok<T>({ jobId: job.jobId, job });
  }
  if (method === "POST" && pathname === "/ops/publish/jobs") {
    const body = request.body as { action?: string; version?: string };
    const key = request.idempotencyKey ?? "";
    const jobId = `j-${key.replaceAll("-", "").slice(0, 12)}`;
    if (job?.jobId === jobId) return ok<T>({ jobId, job }, 202);
    if (job && (job.state === "pending" || job.state === "running")) {
      return {
        ok: false,
        status: 409,
        code: "conflict",
        requestId: null,
        reason: "busy",
      };
    }
    job = {
      jobId,
      action: body.action === "rollback" ? "rollback" : "publish",
      ...(body.version ? { target: body.version } : {}),
      state: "pending",
      createdAt: iso(Date.now()),
      overdue: false,
    };
    return ok<T>({ jobId, job }, 202);
  }
  const reapply = /^\/ops\/publish\/holds\/([^/]+)\/reapply$/.exec(pathname);
  if (method === "POST" && reapply) {
    const id = decodeURIComponent(reapply[1]!);
    const sent = (request.body as { version?: number }).version;
    if (sent !== held.version || !held.items.some((i) => i.id === id)) {
      return {
        ok: false,
        status: 409,
        code: "conflict",
        requestId: null,
        reason: "version",
      };
    }
    held = {
      version: held.version + 1,
      items: held.items.filter((i) => i.id !== id),
    };
    return ok<T>({ noticeId: id, holdVersion: held.version });
  }
  return null;
}
