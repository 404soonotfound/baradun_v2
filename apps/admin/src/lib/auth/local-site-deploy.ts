import type { OpsResult } from "./ops-fetch";

// 로컬 개발 서버의 사이트 배포 칸 예시 응답(#472). 실제 GitHub·운영 API를 부르지 않음
// - 화면 주소 ?deploy=<상황>으로 고름(없으면 ready). E2E도 같은 응답을 가짜 응답으로 씀
// - 모양은 services/src/admin/site-deploy.ts 응답과 같음. 커밋·주소는 예시 값

export const LOCAL_DEPLOY_SCENARIOS = [
  "ready",
  "deploying",
  "paused",
  "ci_pending",
  "partial",
  "admin_unconfigured",
] as const;
export type LocalDeployScenario = (typeof LOCAL_DEPLOY_SCENARIOS)[number];

const REPO = "https://github.com/404soonotfound/baradun_v2";
const MINUTE = 60_000;
const KST_MS = 9 * 60 * MINUTE;
const DAY_MS = 24 * 60 * MINUTE;

// 예시 SHA(40자리 16진수). 앞 7자리가 서로 다름
export const sampleSha = (n: number) =>
  n.toString(16).padStart(7, "0") + "c".repeat(33);

const TITLES = [
  "GH-470 feat(web): 해변 상세 안내 문구 정리",
  "GH-468 fix(admin): 공지 목록 정렬 기준 보완",
  "GH-466 chore(data): 해변 좌표 3곳 갱신",
  "GH-465 style(web): 배지 간격 조정",
  "GH-463 test(admin): 수집 현황 E2E 보강",
  "GH-461 fix(web): 검색 결과 없음 문구 키 정리",
  "GH-459 refactor(admin): 표 공통 부품 정리",
  "GH-457 docs: 운영 안내 갱신",
  "GH-455 feat(admin): 변경 이력 필터 추가",
  "GH-454 fix(web): 지도 확대 버튼 포커스 보완",
  "GH-452 chore(deps): 개발 의존성 갱신",
  "GH-451 fix(data): 해변 메타 오탈자 수정",
];

const iso = (ms: number) => new Date(ms).toISOString();

function nextSchedule(now: number): string {
  const midnight = Math.floor((now + KST_MS) / DAY_MS) * DAY_MS - KST_MS;
  const today = midnight + (5 * 60 + 17) * MINUTE;
  return iso(today > now ? today : today + DAY_MS);
}

const known = <T>(value: T, at: string) => ({
  status: "known" as const,
  value,
  checkedAt: at,
});

const commit = (n: number) => ({
  sha: sampleSha(n),
  title: TITLES[(n - 1) % TITLES.length]!,
});

const run = (
  id: number,
  event: "schedule" | "workflow_dispatch",
  status: string,
  createdAt: string,
  sha: string,
) => ({
  id,
  event,
  status,
  attempt: 1,
  conclusion: status === "completed" ? "success" : null,
  sha,
  createdAt,
  url: `${REPO}/actions/runs/${id}`,
});

export function localSiteDeployView(
  scenario: LocalDeployScenario,
  now: number,
): Record<string, unknown> {
  const at = iso(now - 4_000);
  const head = 12;
  // 사용자 사이트는 커밋 1, 운영자 사이트는 커밋 5에 배포돼 있음 → main(12)까지 아직 안 나간 커밋
  const siteBase = sampleSha(0);
  const adminBase = sampleSha(5);
  const commits = (from: number) =>
    Array.from({ length: head - from }, (_, i) => commit(from + i + 1));
  const siteChanges = {
    from: siteBase,
    to: sampleSha(head),
    files: [
      {
        path: "data/beaches/b0001.json",
        previous: null,
        category: "beach",
      },
      {
        path: "apps/web/src/components/beach-detail.tsx",
        previous: null,
        category: "site",
      },
      {
        path: "apps/web/messages/ko.json",
        previous: null,
        category: "site",
      },
      { path: "package-lock.json", previous: null, category: "shared" },
    ],
    commits: commits(0),
  };
  const adminChanges = {
    from: adminBase,
    to: sampleSha(head),
    files: [
      {
        path: "apps/admin/src/components/notices-table.tsx",
        previous: "apps/admin/src/components/notice-list.tsx",
        category: "admin",
      },
      { path: "package-lock.json", previous: null, category: "shared" },
    ],
    commits: commits(5),
  };
  const manualRun = run(
    9001,
    "workflow_dispatch",
    "completed",
    iso(now - 95 * MINUTE),
    siteBase,
  );
  const active =
    scenario === "deploying"
      ? [
          run(
            9002,
            "workflow_dispatch",
            "in_progress",
            iso(now - 2 * MINUTE),
            sampleSha(head),
          ),
        ]
      : [];
  const paused = scenario === "paused";
  const view: Record<string, unknown> = {
    generatedAt: iso(now),
    readiness:
      scenario === "ready"
        ? "ready"
        : scenario === "deploying"
          ? "deploying"
          : scenario === "paused"
            ? "paused"
            : scenario === "ci_pending"
              ? "ci_pending"
              : "unknown",
    readinessCheckedAt: at,
    main: known(commit(head), at),
    ci: known(scenario === "ci_pending" ? "pending" : "success", at),
    settings: known({ paused, configured: true }, at),
    workflowActive: known(true, at),
    deployments: known({ recent: active[0] ?? manualRun, active }, at),
    approvals: known([], at),
    recentJobs: known({ run: manualRun, apps: {} }, at),
    manualCount: known({ since: iso(now - 60 * MINUTE), requests: 2 }, at),
    tokenExpiry: known(
      new Date(now + KST_MS + 90 * DAY_MS).toISOString().slice(0, 10),
      at,
    ),
    sites: [
      {
        app: "site",
        deployed: known(siteBase, at),
        detail: known(
          { sha: siteBase, title: "GH-449 feat(web): 대안 해변 안내 추가" },
          at,
        ),
        changes: known(siteChanges, at),
        matchedRun: {
          event: "workflow_dispatch",
          url: manualRun.url,
          completedAt: iso(now - 88 * MINUTE),
        },
      },
      {
        app: "admin",
        deployed: known(adminBase, at),
        detail: known(commit(5), at),
        changes: known(adminChanges, at),
        matchedRun: null,
      },
    ],
    nextScheduledAt: paused ? null : nextSchedule(now),
    workflowUrl: `${REPO}/actions/workflows/deploy.yml`,
  };
  const sites = view.sites as Record<string, unknown>[];
  if (scenario === "partial") {
    const retryAt = iso(now + 12 * MINUTE);
    const earlier = iso(now - 6 * MINUTE);
    sites[0]!.changes = {
      status: "unknown",
      reason: "truncated",
      checkedAt: at,
    };
    sites[1]!.deployed = {
      status: "unknown",
      reason: "rate_limit",
      checkedAt: at,
      retryAt,
      last: known(adminBase, earlier),
    };
    sites[1]!.detail = {
      status: "unknown",
      reason: "rate_limit",
      checkedAt: at,
      retryAt,
    };
    sites[1]!.changes = {
      status: "unknown",
      reason: "rate_limit",
      checkedAt: at,
      retryAt,
    };
    view.manualCount = {
      status: "unknown",
      reason: "rate_limit",
      checkedAt: at,
      retryAt,
      last: known({ since: iso(now - 60 * MINUTE), requests: 1 }, earlier),
    };
    view.tokenExpiry = known(
      new Date(now + KST_MS + 20 * DAY_MS).toISOString().slice(0, 10),
      at,
    );
  }
  if (scenario === "admin_unconfigured") {
    for (const key of ["deployed", "detail", "changes"]) {
      sites[1]![key] = {
        status: "unknown",
        reason: "unconfigured",
        checkedAt: at,
      };
    }
  }
  return view;
}

export function localSiteDeploy<T>(): OpsResult<T> {
  const asked =
    typeof window === "undefined"
      ? null
      : new URLSearchParams(window.location.search).get("deploy");
  const scenario =
    LOCAL_DEPLOY_SCENARIOS.find((name) => name === asked) ?? "ready";
  return {
    ok: true,
    status: 200,
    body: localSiteDeployView(scenario, Date.now()) as T,
  };
}
