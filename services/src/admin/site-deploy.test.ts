import { describe, expect, it, vi } from "vitest";
import { createSiteDeployReader } from "./site-deploy";
import { createSiteDeployGitHub } from "./site-deploy-github";

const HEAD = "a".repeat(40);
const DEPLOYED = "b".repeat(40);
const REPO = "example/project";
const START = "2026-11-14T15:00:00Z";
const config = {
  repo: REPO,
  site: "https://web.example",
  admin: "https://ops.example",
};
const commit = (sha: string) => ({
  sha,
  commit: { message: "GH-123 테스트 변경\n본문" },
});
const run = (overrides: Record<string, unknown> = {}) => ({
  id: 17,
  run_attempt: 1,
  event: "workflow_dispatch",
  status: "completed",
  conclusion: "success",
  head_sha: DEPLOYED,
  head_branch: "main",
  created_at: START,
  ...overrides,
});
const runs = (...workflow_runs: unknown[]) => ({
  total_count: workflow_runs.length,
  workflow_runs,
});
const settings = (value?: string) => {
  const variables = [
    ...[
      "DEPLOY_ROLE_ARN",
      "SITE_BUCKET",
      "DISTRIBUTION_ID",
      "SITE_URL",
      "INQUIRY_PHOTO_BUCKET",
      "ADMIN_SITE_BUCKET",
      "ADMIN_DISTRIBUTION_ID",
      "OPERATOR_USER_POOL_ID",
      "OPERATOR_CLIENT_ID",
      "DEMO_USER_POOL_ID",
      "DEMO_CLIENT_ID",
    ].map((name) => ({
      name,
      value: name.endsWith("_POOL_ID")
        ? "ap-northeast-2_Example"
        : "configured",
    })),
    ...(value === undefined ? [] : [{ name: "DEPLOY_PAUSED", value }]),
  ];
  return { total_count: variables.length, variables };
};
const diff = {
  status: "ahead",
  merge_base_commit: { sha: DEPLOYED },
  total_commits: 1,
  commits: [commit(HEAD)],
  files: [
    { filename: "apps/web/app/page.tsx" },
    { filename: "apps/web-legacy/other.ts" },
    { filename: "apps/admin/page.tsx" },
    { filename: "data/beaches/beach.json" },
    { filename: "outside.ts", previous_filename: "apps/admin/removed.ts" },
  ],
};

function setup(override: (url: URL) => Response | undefined = () => undefined) {
  let at = new Date(START);
  const request = vi.fn(async (input: URL | RequestInfo) => {
    const url = new URL(String(input));
    const custom = override(url);
    if (custom) return custom;
    if (url.hostname !== "api.github.com") return new Response(DEPLOYED + "\n");
    if (url.pathname.endsWith("/commits/main"))
      return Response.json(commit(HEAD));
    if (url.pathname.endsWith("/commits/" + DEPLOYED))
      return Response.json(commit(DEPLOYED));
    if (url.pathname.includes("/compare/")) return Response.json(diff);
    if (url.pathname.endsWith("/variables")) return Response.json(settings());
    if (url.pathname.endsWith("/deploy.yml"))
      return Response.json({ state: "active" });
    if (url.pathname.includes("/ci.yml/runs")) {
      return Response.json(runs(run({ event: "push", head_sha: HEAD })));
    }
    if (url.pathname.endsWith("/pending_deployments")) return Response.json([]);
    if (url.pathname.endsWith("/jobs"))
      return Response.json({ total_count: 0, jobs: [] });
    if (url.pathname.includes("/deploy.yml/runs")) return Response.json(runs());
    throw new Error("Unexpected request");
  });
  const credential = {
    token: vi.fn(async () => "fixture-value"),
    expiry: vi.fn(async () => "2027-01-01"),
  };
  const read = createSiteDeployReader(
    config,
    credential,
    () => at,
    request as typeof fetch,
  );
  return {
    read,
    request,
    credential,
    setTime: (time: string) => {
      at = new Date(time);
    },
  };
}

describe("사이트 배포 상태 조회(D27-3·5)", () => {
  it("같은 main SHA로 비교하고 앱 경로와 이름이 바뀐 파일을 구분한다", async () => {
    const { read, request } = setup();
    const result = await read();
    expect(result.readiness).toBe("ready");
    expect(result.ci).toMatchObject({ value: "success" });
    expect(result.nextScheduledAt).toBe("2026-11-14T20:17:00.000Z");
    expect(result.sites[0]?.changes).toMatchObject({
      value: {
        from: DEPLOYED,
        to: HEAD,
        files: [
          { path: "apps/web/app/page.tsx", category: "site" },
          { path: "data/beaches/beach.json", category: "beach" },
        ],
      },
    });
    expect(result.sites[1]?.changes).toMatchObject({
      value: {
        files: [
          { path: "apps/admin/page.tsx" },
          { path: "data/beaches/beach.json" },
          {
            path: "outside.ts",
            previous: "apps/admin/removed.ts",
            category: "admin",
          },
        ],
      },
    });
    expect(request.mock.calls.map(([url]) => String(url))).not.toContainEqual(
      expect.stringContaining("event=workflow_run"),
    );
  });

  it.each([
    [
      "pending",
      run({
        event: "push",
        head_sha: HEAD,
        status: "in_progress",
        conclusion: null,
      }),
      "ci_pending",
    ],
    [
      "failure",
      run({ event: "push", head_sha: HEAD, conclusion: "failure" }),
      "ci_failed",
    ],
    ["missing", null, "ci_missing"],
    ["unknown", "bad", "unknown"],
  ])("CI %s 상태로 배포 가능 판정을 막는다", async (value, item, expected) => {
    const { read } = setup((url) =>
      url.pathname.includes("/ci.yml/runs")
        ? item === "bad"
          ? new Response(null, { status: 500 })
          : Response.json(item ? runs(item) : runs())
        : undefined,
    );
    const result = await read();
    expect(result.readiness).toBe(expected);
    expect(result.ci).toMatchObject(
      value === "unknown"
        ? { status: "unknown", reason: "unavailable" }
        : { status: "known", value },
    );
  });

  it.each([
    ["true", true, "paused"],
    ["false", false, "ready"],
  ] as const)(
    "정지 변수 %s를 읽고 일정을 계산한다",
    async (value, paused, expected) => {
      const { read } = setup((url) =>
        url.pathname.endsWith("/variables")
          ? Response.json(settings(value))
          : undefined,
      );
      const result = await read();
      expect(result.settings).toMatchObject({ value: { paused } });
      expect(result.readiness).toBe(expected);
      if (paused) expect(result.nextScheduledAt).toBeNull();
    },
  );

  it.each([
    [403, "forbidden"],
    [404, "not_found"],
    [429, "rate_limit"],
  ] as const)(
    "변수 조회 %s를 정지 해제로 취급하지 않는다",
    async (status, reason) => {
      const { read } = setup((url) =>
        url.pathname.endsWith("/variables")
          ? new Response(null, { status })
          : undefined,
      );
      const result = await read();
      expect(result.readiness).toBe("unknown");
      expect(result.settings).toMatchObject({ status: "unknown", reason });
      expect(result.nextScheduledAt).toBeNull();
    },
  );

  it("필수 변수가 없거나 워크플로가 비활성화되면 배포할 수 없다", async () => {
    const withoutBucket = setup((url) => {
      if (!url.pathname.endsWith("/variables")) return undefined;
      const variables = settings().variables.filter(
        ({ name }) => name !== "SITE_BUCKET",
      );
      return Response.json({ total_count: variables.length, variables });
    });
    expect((await withoutBucket.read()).readiness).toBe("unconfigured");

    const disabled = setup((url) =>
      url.pathname.endsWith("/deploy.yml")
        ? Response.json({ state: "disabled_manually" })
        : undefined,
    );
    expect(await disabled.read()).toMatchObject({
      readiness: "unconfigured",
      nextScheduledAt: null,
      workflowActive: { status: "known", value: false },
    });
  });

  it.each([
    ["queued", "deploying"],
    ["waiting", "approval_pending"],
  ] as const)("활성 실행 %s 상태를 따로 표시한다", async (status, expected) => {
    const { read } = setup((url) => {
      if (url.pathname.endsWith("/pending_deployments")) {
        return Response.json(
          status === "waiting"
            ? [{ environment: { name: "production" }, reviewers: [{}] }]
            : [],
        );
      }
      if (
        url.pathname.includes("/deploy.yml/runs") &&
        url.searchParams.get("event") === "workflow_dispatch" &&
        !url.searchParams.has("created")
      )
        return Response.json(runs(run({ status, conclusion: null })));
      return undefined;
    });
    const result = await read();
    expect(result.readiness).toBe(expected);
    expect(result.deployments).toMatchObject({
      value: { active: [{ id: 17 }] },
    });
  });

  it.each([
    [404, "not_found"],
    [200, "invalid"],
  ] as const)(
    "공개 커밋 표시 %s 또는 형식 오류가 있는 앱의 변경을 0건으로 두지 않는다",
    async (status, reason) => {
      const { read } = setup((url) =>
        url.hostname === "ops.example"
          ? new Response(status === 200 ? "invalid" : null, { status })
          : undefined,
      );
      const result = await read();
      expect(result.readiness).toBe("unknown");
      expect(result.sites[1]?.deployed).toMatchObject({
        status: "unknown",
        reason,
      });
      expect(result.sites[1]?.changes).toMatchObject({
        status: "unknown",
        reason,
      });
      expect(result.sites[0]?.deployed).toMatchObject({ value: DEPLOYED });
    },
  );

  it.each([
    [{ ...diff, status: "diverged" }, "not_ancestor"],
    [
      { ...diff, files: Array(300).fill({ filename: "apps/web/file" }) },
      "truncated",
    ],
    [
      { ...diff, commits: Array(250).fill(commit(HEAD)), total_commits: 250 },
      "truncated",
    ],
  ])("Compare의 불완전한 결과를 확인 실패로 표시한다", async (data, reason) => {
    const { read } = setup((url) =>
      url.pathname.includes("/compare/") ? Response.json(data) : undefined,
    );
    const result = await read();
    expect(result.readiness).toBe("unknown");
    expect(result.sites[0]?.changes).toMatchObject({
      status: "unknown",
      reason,
    });
  });

  it("배포와 main SHA가 같으면 변경이 없음을 확인한다", async () => {
    const { read } = setup((url) =>
      url.hostname !== "api.github.com"
        ? new Response(HEAD)
        : url.pathname.endsWith("/commits/" + HEAD)
          ? Response.json(commit(HEAD))
          : undefined,
    );
    expect((await read()).sites[0]?.changes).toMatchObject({
      status: "known",
      value: { files: [], commits: [] },
    });
  });

  it("최근 수동 실행의 전체 실패와 사이트별 성공을 구분한다", async () => {
    const { read } = setup((url) => {
      if (url.pathname.endsWith("/jobs")) {
        return Response.json({
          total_count: 2,
          jobs: [
            {
              name: "site",
              status: "completed",
              conclusion: "success",
              completed_at: START,
              steps: [{ name: "올린 커밋 표시", conclusion: "success" }],
            },
            {
              name: "admin",
              status: "completed",
              conclusion: "failure",
              completed_at: START,
              steps: [{ name: "올린 커밋 표시", conclusion: "skipped" }],
            },
          ],
        });
      }
      if (
        url.pathname.includes("/deploy.yml/runs") &&
        url.searchParams.get("event") === "workflow_dispatch"
      ) {
        return Response.json(runs(run({ conclusion: "failure" })));
      }
      return undefined;
    });
    const result = await read();
    expect(result.recentJobs).toMatchObject({
      value: {
        run: { conclusion: "failure" },
        apps: { site: { wroteMarker: true }, admin: { wroteMarker: false } },
      },
    });
    expect(result.sites[0]?.matchedRun).toMatchObject({
      event: "workflow_dispatch",
      completedAt: START,
    });
    expect(result.sites[1]?.matchedRun).toBeNull();
  });

  it("새 main의 CI가 확인되지 않으면 이전 SHA의 성공을 재사용하지 않는다", async () => {
    const next = "c".repeat(40);
    let head = HEAD;
    const { read, setTime } = setup((url) => {
      if (url.pathname.endsWith("/commits/main"))
        return Response.json(commit(head));
      if (url.pathname.includes("/ci.yml/runs")) {
        return head === HEAD
          ? Response.json(runs(run({ event: "push", head_sha: HEAD })))
          : new Response(null, { status: 500 });
      }
      return undefined;
    });
    expect((await read()).readiness).toBe("ready");
    setTime("2026-11-14T15:00:10Z");
    expect((await read()).readinessCheckedAt).toBe("2026-11-14T15:00:00.000Z");
    setTime("2026-11-14T15:00:31Z");
    head = next;
    const result = await read();
    expect(result.readiness).toBe("unknown");
    expect(result.main).toMatchObject({ value: { sha: next } });
    expect(result.ci).toMatchObject({
      status: "unknown",
      reason: "unavailable",
    });
    expect(result.ci).not.toHaveProperty("last");
  });

  it("KST 자정에 30초 캐시가 남아도 다시 집계하고 끝 페이지까지 센다", async () => {
    const { read, setTime } = setup((url) => {
      if (!url.searchParams.has("created")) return undefined;
      if (url.searchParams.get("page") === "1") {
        return Response.json(runs(run()), {
          headers: {
            link: '<https://api.github.com/example?page=2>; rel="next"',
          },
        });
      }
      return Response.json(
        runs(
          run({
            id: 16,
            created_at: "2026-11-14T14:59:59Z",
            conclusion: "cancelled",
          }),
        ),
      );
    });
    setTime("2026-11-14T14:59:59.900Z");
    expect((await read()).manualCount).toMatchObject({
      value: { requests: 1, since: "2026-11-13T15:00:00.000Z" },
    });
    setTime(START);
    expect((await read()).manualCount).toMatchObject({
      value: { requests: 1, since: "2026-11-14T15:00:00.000Z" },
    });
  });

  it("성공 항목만 캐시하고 재조회 실패 시 이전 확인값을 붙인다", async () => {
    let failure = false;
    const { read, request, setTime } = setup((url) =>
      failure && url.pathname.endsWith("/variables")
        ? new Response(null, { status: 500 })
        : undefined,
    );
    await read();
    const count = request.mock.calls.length;
    await read();
    expect(request).toHaveBeenCalledTimes(count);
    setTime("2026-11-14T15:00:31Z");
    failure = true;
    expect((await read()).settings).toMatchObject({
      status: "unknown",
      reason: "unavailable",
      last: { value: { paused: false } },
    });
    failure = false;
    expect((await read()).settings).toMatchObject({ status: "known" });
  });

  it("전체 제한 시간에 도달하면 응답 없는 조회를 포기하고 완료된 값을 돌려준다", async () => {
    const { request, credential } = setup();
    const read = createSiteDeployReader(
      config,
      credential,
      () => new Date(START),
      (async (input, init) =>
        String(input).includes("/variables")
          ? new Promise<Response>(() => undefined)
          : request(input)) as typeof fetch,
      30,
    );
    const result = await read();
    expect(result.settings).toMatchObject({
      status: "unknown",
      reason: "timeout",
    });
    expect(result.readiness).toBe("unknown");
    expect(result.main).toMatchObject({ status: "known" });
  });

  it("예외에 포함된 조회 토큰이 응답과 로그에 남지 않는다", async () => {
    const log = vi.spyOn(console, "log");
    const warning = vi.spyOn(console, "warn");
    const error = vi.spyOn(console, "error");
    try {
      const { read } = setup((url) => {
        if (url.hostname === "api.github.com") throw new Error("fixture-value");
        return undefined;
      });
      expect(JSON.stringify(await read())).not.toContain("fixture-value");
      expect(log).not.toHaveBeenCalled();
      expect(warning).not.toHaveBeenCalled();
      expect(error).not.toHaveBeenCalled();
    } finally {
      log.mockRestore();
      warning.mockRestore();
      error.mockRestore();
    }
  });
});

describe("GitHub REST 조회", () => {
  it("ETag 304에서 본문과 페이지 링크를 재사용하고 Retry-After 동안 재호출하지 않는다", async () => {
    let now = new Date(START);
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json(
          { data: 1 },
          {
            headers: {
              etag: '"one"',
              link: '<https://api.github.com/?page=2>; rel="next"',
            },
          },
        ),
      )
      .mockResolvedValueOnce(new Response(null, { status: 304 }))
      .mockResolvedValueOnce(
        new Response(null, { status: 429, headers: { "retry-after": "10" } }),
      )
      .mockResolvedValueOnce(Response.json({ data: 2 }));
    const read = createSiteDeployGitHub(REPO, request, () => now);
    const signal = new AbortController().signal;
    expect(await read("/items", "fixture-value", signal)).toEqual({
      body: { data: 1 },
      next: true,
    });
    expect(await read("/items", "fixture-value", signal)).toEqual({
      body: { data: 1 },
      next: true,
    });
    expect(request.mock.calls[1]?.[1]?.headers).toMatchObject({
      "If-None-Match": '"one"',
    });
    await expect(read("/items", "fixture-value", signal)).rejects.toMatchObject(
      {
        reason: "rate_limit",
        retryAt: Date.parse(START) + 10_000,
      },
    );
    await expect(read("/other", "fixture-value", signal)).rejects.toMatchObject(
      { reason: "rate_limit" },
    );
    expect(request).toHaveBeenCalledTimes(3);
    now = new Date(Date.parse(START) + 10_000);
    expect(await read("/items", "fixture-value", signal)).toEqual({
      body: { data: 2 },
      next: false,
    });
  });
});
