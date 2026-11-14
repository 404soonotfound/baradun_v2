import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { localSiteDeployView, sampleSha } from "./auth/local-site-deploy";
import { messages } from "./messages";
import {
  CI_STATES,
  COMMIT_LIMIT,
  FILE_CATEGORIES,
  READINESS,
  SITE_DEPLOY_REASONS,
  field,
  issuePrefix,
  kstTime,
  lastText,
  manualDay,
  parseSiteDeploy,
  pendingCommits,
  reasonText,
  refreshInterval,
  repoUrl,
  scheduleLabel,
  tokenExpiryState,
  type SiteView,
} from "./site-deploy";

const t = messages.siteDeploy;
// 응답을 읽어 view를 돌려줌(읽지 못하면 시험 실패)
const parse = (raw: unknown) => {
  const view = parseSiteDeploy(raw);
  if (!view) throw new Error("parse failed");
  return view;
};
const NOW = Date.parse("2026-11-14T03:00:00Z");
const AT = "2026-11-14T02:59:56.000Z";

const server = (file: string) =>
  readFileSync(
    fileURLToPath(
      new URL(`../../../../services/src/admin/${file}`, import.meta.url),
    ),
    "utf8",
  );
const literals = (source: string, start: RegExp) => {
  const from = source.search(start);
  const body = source.slice(from, source.indexOf(";", from));
  return [...body.matchAll(/"([a-z_]+)"/g)].map((m) => m[1]);
};

describe("서버 응답 모양과 맞춤(services/src/admin/site-deploy*.ts)", () => {
  it("사유·readiness·CI 상태·파일 분류 목록이 서버 타입과 같다", () => {
    const github = server("site-deploy-github.ts");
    const deploy = server("site-deploy.ts");
    expect(literals(github, /export type SiteDeployReason =/)).toEqual([
      ...SITE_DEPLOY_REASONS,
    ]);
    expect(literals(deploy, /type Readiness =/)).toEqual([...READINESS]);
    expect(literals(deploy, /type CiState =/)).toEqual([...CI_STATES]);
    const classify = deploy.slice(
      deploy.indexOf("export function classifyDeployPath"),
      deploy.indexOf("{", deploy.indexOf("export function classifyDeployPath")),
    );
    expect([...classify.matchAll(/"([a-z]+)"/g)].map((m) => m[1])).toEqual([
      ...FILE_CATEGORIES,
    ]);
  });

  it("응답 최상위 키가 서버 collect()의 반환 키와 같다", () => {
    const deploy = server("site-deploy.ts");
    const from = deploy.lastIndexOf(
      "return {",
      deploy.indexOf("generatedAt: started.toISOString()"),
    );
    const body = deploy.slice(from, deploy.indexOf("} finally", from));
    const keys = [...body.matchAll(/^ {8}(\w+)[:,]/gm)].map((m) => m[1]);
    const parsed = parse(localSiteDeployView("ready", NOW));
    expect(keys.sort()).toEqual(Object.keys(parsed).sort());
  });

  it("사이트 항목 키(app·deployed·detail·changes·matchedRun)가 서버와 같다", () => {
    const deploy = server("site-deploy.ts");
    for (const key of [
      "deployed: await deployed",
      "detail: await detail",
      "changes: await changes",
      "matchedRun",
    ]) {
      expect(deploy).toContain(key);
    }
    const parsed = parse(localSiteDeployView("ready", NOW));
    expect(Object.keys(parsed.sites[0]!).sort()).toEqual(
      ["app", "changes", "deployed", "detail", "matchedRun"].sort(),
    );
  });
});

describe("parseSiteDeploy: 응답 모양 검사", () => {
  it("로컬 예시(ready)는 모든 칸을 확인한 값으로 읽고 ready를 유지한다", () => {
    const view = parse(localSiteDeployView("ready", NOW));
    expect(view.readiness).toBe("ready");
    expect(view.main.status).toBe("known");
    expect(view.sites.map((s) => s.app)).toEqual(["site", "admin"]);
    expect(view.sites.every((s) => s.changes.status === "known")).toBe(true);
    expect(view.workflowUrl).toMatch(/^https:\/\/github\.com\//);
  });

  it("빠진 칸은 확인 못 함(invalid)으로 바꾸고 ready를 띄우지 않는다", () => {
    const raw = localSiteDeployView("ready", NOW);
    delete raw.ci;
    const view = parse(raw);
    expect(view.ci).toEqual({
      status: "unknown",
      reason: "invalid",
      checkedAt: raw.generatedAt,
    });
    expect(view.readiness).toBe("unknown");
  });

  it("사이트 하나가 빠지면 그 사이트 칸은 모두 확인 못 함이고 ready가 아니다", () => {
    const raw = localSiteDeployView("ready", NOW);
    raw.sites = (raw.sites as { app: string }[]).filter(
      (s) => s.app !== "admin",
    );
    const view = parse(raw);
    const admin = view.sites.find((s) => s.app === "admin")!;
    expect(admin.deployed.status).toBe("unknown");
    expect(admin.changes.status).toBe("unknown");
    expect(admin.matchedRun).toBeNull();
    expect(view.readiness).toBe("unknown");
  });

  it("변경 목록 형식이 틀리면 0건이 아니라 확인 못 함", () => {
    const raw = localSiteDeployView("ready", NOW);
    const site = (raw.sites as Record<string, unknown>[])[0]!;
    site.changes = { status: "known", value: { files: null }, checkedAt: AT };
    const view = parse(raw);
    expect(view.sites[0]!.changes.status).toBe("unknown");
  });

  it("객체가 아니거나 생성 시각이 없는 응답은 읽지 못함(null) · 화면 시계로 확인 시각을 지어내지 않음", () => {
    expect(parseSiteDeploy(null)).toBeNull();
    expect(parseSiteDeploy("<html>")).toBeNull();
    const raw = localSiteDeployView("ready", NOW);
    delete raw.generatedAt;
    expect(parseSiteDeploy(raw)).toBeNull();
  });

  it("생성 시각만 있는 응답은 칸마다 확인 못 함 · 그 시각을 확인 시각으로", () => {
    const view = parse({ generatedAt: AT });
    expect(view.readiness).toBe("unknown");
    expect(view.main).toMatchObject({ status: "unknown", checkedAt: AT });
    expect(view.sites).toHaveLength(2);
    expect(view.workflowUrl).toBeNull();
    expect(view.nextScheduledAt).toBeNull();
  });

  it("모르는 readiness는 unknown", () => {
    const raw = localSiteDeployView("ready", NOW);
    raw.readiness = "safe";
    expect(parse(raw).readiness).toBe("unknown");
  });

  it("서버가 ready라도 진행 중 실행·일시 정지가 있으면 ready로 보이지 않는다", () => {
    const paused = localSiteDeployView("paused", NOW);
    paused.readiness = "ready";
    expect(parse(paused).readiness).toBe("unknown");
    const deploying = localSiteDeployView("deploying", NOW);
    deploying.readiness = "ready";
    expect(parse(deploying).readiness).toBe("unknown");
  });

  it("GitHub 주소가 아닌 workflowUrl·실행 주소는 버린다", () => {
    const raw = localSiteDeployView("ready", NOW);
    raw.workflowUrl = "javascript:alert(1)";
    const site = (raw.sites as Record<string, unknown>[])[0]!;
    site.matchedRun = {
      event: "workflow_dispatch",
      url: "https://example.test/run",
      completedAt: AT,
    };
    const view = parse(raw);
    expect(view.workflowUrl).toBeNull();
    expect(repoUrl(view)).toBeNull();
    expect(view.sites[0]!.matchedRun).toBeNull();
  });

  it("unknown 칸의 앞 값·다시 확인 시각을 살리고, 형식이 틀린 앞 값은 버린다", () => {
    const sha = (v: unknown) =>
      typeof v === "string" && /^[a-f\d]{40}$/.test(v) ? v : undefined;
    const good = field(
      {
        status: "unknown",
        reason: "rate_limit",
        checkedAt: AT,
        retryAt: "2026-11-14T03:12:00Z",
        last: { status: "known", value: sampleSha(3), checkedAt: AT },
      },
      sha,
      AT,
    );
    expect(good).toMatchObject({
      status: "unknown",
      reason: "rate_limit",
      retryAt: "2026-11-14T03:12:00Z",
      last: { value: sampleSha(3) },
    });
    const bad = field(
      {
        status: "unknown",
        reason: "timeout",
        checkedAt: AT,
        last: { status: "known", value: "zzz", checkedAt: AT },
      },
      sha,
      AT,
    );
    expect(bad).toEqual({
      status: "unknown",
      reason: "timeout",
      checkedAt: AT,
    });
    // 모르는 사유는 invalid
    expect(
      field({ status: "unknown", reason: "boom", checkedAt: AT }, sha, AT),
    ).toMatchObject({ reason: "invalid" });
  });
});

describe("readiness → 문구", () => {
  it("모든 readiness에 문구가 있고 '배포할 수 있어요'는 ready에만 있다", () => {
    for (const r of READINESS) {
      const text = t.readiness[r];
      expect(text).toBeTruthy();
      expect(text.includes("배포할 수 있어요")).toBe(r === "ready");
    }
    expect(t.readiness.ready).toBe("main 최신 커밋을 배포할 수 있어요");
    expect(t.readiness.unknown).toBe("GitHub 상태를 확인하지 못했어요");
  });

  it("문구에 추천·안전 표현이 없다", () => {
    const all = JSON.stringify(t);
    expect(all).not.toMatch(/추천|안전/);
  });
});

describe("reason → 문구", () => {
  it("사유마다 사람 말로 바꾸고 내부 코드를 보이지 않는다", () => {
    for (const reason of SITE_DEPLOY_REASONS) {
      const text = reasonText(reason, NOW);
      // 브랜치 이름 main만 영어로 둠
      expect(text.replace("main", "")).not.toMatch(/[a-z_]{4,}/);
    }
    expect(reasonText("unconfigured", NOW)).toBe("설정이 필요해요");
    expect(reasonText("credential_missing", NOW)).toBe(
      "GitHub 조회 토큰을 확인해 주세요",
    );
    expect(reasonText("credentials", NOW)).toBe(
      "GitHub 조회 토큰을 확인해 주세요",
    );
    expect(reasonText("unauthorized", NOW)).toBe(
      "GitHub 토큰 인증에 실패했어요",
    );
    expect(reasonText("truncated", NOW)).toBe(
      "변경이 많아 다 확인하지 못했어요 · GitHub에서 확인하세요",
    );
    expect(reasonText("not_ancestor", NOW)).toBe(
      "배포된 커밋이 main 기록에 없어요",
    );
    for (const r of [
      "timeout",
      "unavailable",
      "forbidden",
      "not_found",
      "invalid",
    ] as const)
      expect(reasonText(r, NOW)).toBe("확인하지 못했어요");
  });

  it("조회 한도는 다시 확인할 KST 시각을 함께 보인다", () => {
    expect(reasonText("rate_limit", NOW, "2026-11-14T03:12:00Z")).toBe(
      "GitHub 조회 한도에 걸렸어요 · 12:12 이후 다시 확인해요",
    );
    expect(reasonText("rate_limit", NOW)).toBe(
      "GitHub 조회 한도에 걸렸어요 · 잠시 뒤 다시 확인해요",
    );
  });
});

describe("last 표시", () => {
  it("앞 값이 있으면 그 확인 시각(KST)으로 '마지막으로 확인한 값'", () => {
    expect(
      lastText(
        {
          status: "unknown",
          reason: "timeout",
          checkedAt: AT,
          last: {
            status: "known",
            value: 1,
            checkedAt: "2026-11-14T02:54:00Z",
          },
        },
        NOW,
      ),
    ).toBe("마지막으로 확인한 값 · 11:54 기준");
  });
  it("앞 값이 없거나 확인한 칸이면 null", () => {
    expect(
      lastText({ status: "unknown", reason: "timeout", checkedAt: AT }, NOW),
    ).toBeNull();
    expect(
      lastText({ status: "known", value: 1, checkedAt: AT }, NOW),
    ).toBeNull();
  });
});

describe("다음 정기 배포(KST)", () => {
  const known = <T>(value: T) => ({
    status: "known" as const,
    value,
    checkedAt: AT,
  });
  const settings = known({ paused: false, configured: true });
  const workflowActive = known(true);
  const next = (iso: string | null, now: string) =>
    scheduleLabel(
      { nextScheduledAt: iso, settings, workflowActive },
      Date.parse(now),
    );
  it("05:17 직전에는 오늘, 05:17이 지나면 서버가 준 내일 05:17", () => {
    expect(next("2026-11-13T20:17:00.000Z", "2026-11-13T20:16:59Z")).toEqual({
      kind: "today",
      time: "05:17",
    });
    expect(next("2026-11-14T20:17:00.000Z", "2026-11-13T20:17:00Z")).toEqual({
      kind: "tomorrow",
      time: "05:17",
    });
  });
  it("KST 자정 경계: 23:59:59에는 내일, 00:00에는 오늘", () => {
    expect(next("2026-11-13T20:17:00.000Z", "2026-11-13T14:59:59Z")).toEqual({
      kind: "tomorrow",
      time: "05:17",
    });
    expect(next("2026-11-13T20:17:00.000Z", "2026-11-13T15:00:00Z")).toEqual({
      kind: "today",
      time: "05:17",
    });
  });
  it("이미 지난 시각(앞 값을 들고 있을 때)은 오늘이라 하지 않고 날짜와 함께", () => {
    expect(next("2026-11-13T20:17:00.000Z", "2026-11-13T21:00:00Z")).toEqual({
      kind: "passed",
      date: "11/14",
      time: "05:17",
    });
  });
  it("null이면 일시 정지·워크플로 꺼짐을 확인한 때만 멈춤", () => {
    const at = Date.parse("2026-11-13T15:00:00Z");
    expect(
      scheduleLabel(
        {
          nextScheduledAt: null,
          settings: known({ paused: true, configured: true }),
          workflowActive,
        },
        at,
      ),
    ).toEqual({ kind: "paused" });
    expect(
      scheduleLabel(
        { nextScheduledAt: null, settings, workflowActive: known(false) },
        at,
      ),
    ).toEqual({ kind: "paused" });
  });
  it("null인데 설정·워크플로 조회를 못 했으면 멈춤이 아니라 확인 못 함(사유 함께)", () => {
    const at = Date.parse("2026-11-13T15:00:00Z");
    expect(
      scheduleLabel(
        {
          nextScheduledAt: null,
          settings: { status: "unknown", reason: "rate_limit", checkedAt: AT },
          workflowActive,
        },
        at,
      ),
    ).toEqual({ kind: "unknown", reason: "rate_limit" });
    expect(
      scheduleLabel(
        {
          nextScheduledAt: null,
          settings,
          workflowActive: {
            status: "unknown",
            reason: "timeout",
            checkedAt: AT,
          },
        },
        at,
      ),
    ).toEqual({ kind: "unknown", reason: "timeout" });
    // 둘 다 확인했는데 null(응답 모양이 틀림)도 확인 못 함
    expect(
      scheduleLabel({ nextScheduledAt: null, settings, workflowActive }, at),
    ).toEqual({ kind: "unknown", reason: "invalid" });
  });
});

describe("날짜가 다른 시각", () => {
  it("기준 시각과 KST 날짜가 다르면 M/D를 붙임", () => {
    const now = Date.parse("2026-11-14T15:10:00Z"); // KST 11-15 00:10
    expect(kstTime("2026-11-14T14:40:00Z", now)).toBe("11/14 23:40");
    expect(kstTime("2026-11-14T15:05:00Z", now)).toBe("00:05");
    // 자정 직전에 받은 다시 확인 시각이 다음 날이면 날짜와 함께
    const before = Date.parse("2026-11-14T14:50:00Z"); // KST 11-14 23:50
    expect(reasonText("rate_limit", before, "2026-11-14T15:05:00Z")).toBe(
      "GitHub 조회 한도에 걸렸어요 · 11/15 00:05 이후 다시 확인해요",
    );
  });
  it("조회 한도의 다시 확인 시각이 이미 지났으면 시각 없이", () => {
    expect(reasonText("rate_limit", NOW, "2026-11-14T02:59:00Z")).toBe(
      "GitHub 조회 한도에 걸렸어요 · 잠시 뒤 다시 확인해요",
    );
  });
  it("수동 배포 요청 수의 기준 날이 오늘이 아니면 그 날짜", () => {
    const now = Date.parse("2026-11-14T15:10:00Z"); // KST 11-15 00:10
    expect(manualDay("2026-11-14T15:00:00.000Z", now)).toBeNull();
    expect(manualDay("2026-11-13T15:00:00.000Z", now)).toBe("11/14");
  });
});

describe("토큰 만료 30일", () => {
  // 2026-11-14 KST 12:00
  const now = Date.parse("2026-11-14T03:00:00Z");
  const at = (value: string | null) =>
    tokenExpiryState({ status: "known", value, checkedAt: AT }, now);
  it("31일 남으면 평소, 30일 안이면 경고, 오늘은 0일, 지나면 만료됨", () => {
    expect(at("2026-12-15")).toEqual({
      kind: "ok",
      date: "2026-12-15",
      days: 31,
    });
    expect(at("2026-12-14")).toEqual({
      kind: "soon",
      date: "2026-12-14",
      days: 30,
    });
    expect(at("2026-11-14")).toMatchObject({ kind: "soon", days: 0 });
    expect(at("2026-11-13")).toEqual({ kind: "expired", date: "2026-11-13" });
  });
  it("KST 날짜로 셈(UTC로는 전날인 자정 직후도 그날)", () => {
    const early = Date.parse("2026-11-14T15:30:00Z"); // KST 11-15 00:30
    expect(
      tokenExpiryState(
        { status: "known", value: "2026-11-15", checkedAt: AT },
        early,
      ),
    ).toMatchObject({ kind: "soon", days: 0 });
  });
  it("만료일 태그가 없으면 숨김, 조회 실패는 확인 못 함", () => {
    expect(at(null)).toEqual({ kind: "hidden" });
    expect(
      tokenExpiryState(
        { status: "unknown", reason: "credentials", checkedAt: AT },
        now,
      ),
    ).toEqual({ kind: "unknown", reason: "credentials" });
  });
});

describe("커밋 목록·링크·주기", () => {
  it("두 사이트 커밋을 하나로(중복 제거·최신 먼저·최대 N개)", () => {
    const view = parse(localSiteDeployView("ready", NOW));
    const list = pendingCommits(view.sites);
    expect(list.total).toBe(12);
    expect(list.commits).toHaveLength(COMMIT_LIMIT);
    expect(list.commits[0]!.sha).toBe(sampleSha(12));
    expect(list.complete).toBe(true);
    expect(list.compare).toEqual({ from: sampleSha(0), to: sampleSha(12) });
  });

  it("변경을 확인 못 한 사이트가 있으면 complete=false", () => {
    const view = parse(localSiteDeployView("partial", NOW));
    const list = pendingCommits(view.sites);
    expect(list.complete).toBe(false);
    expect(list.total).toBe(0);
  });

  it("빈 목록은 바뀐 것 없음", () => {
    const sites: SiteView[] = ["site", "admin"].map((app) => ({
      app: app as "site",
      deployed: { status: "known", value: sampleSha(1), checkedAt: AT },
      detail: {
        status: "known",
        value: { sha: sampleSha(1), title: "x" },
        checkedAt: AT,
      },
      changes: {
        status: "known",
        value: { from: sampleSha(1), to: sampleSha(1), files: [], commits: [] },
        checkedAt: AT,
      },
      matchedRun: null,
    }));
    expect(pendingCommits(sites)).toMatchObject({
      total: 0,
      complete: true,
      compare: null,
    });
  });

  it("GH-번호는 제목 맨 앞에 있을 때만 이슈 번호 · 제목에 쓰인 글자 그대로 자름", () => {
    expect(issuePrefix("GH-472 feat(admin): 사이트 배포 칸")).toEqual({
      issue: 472,
      label: "GH-472",
      rest: " feat(admin): 사이트 배포 칸",
    });
    expect(issuePrefix("GH-0472 fix(admin): x")).toEqual({
      issue: 472,
      label: "GH-0472",
      rest: " fix(admin): x",
    });
    expect(issuePrefix("docs: README 오타 수정")).toBeNull();
    expect(issuePrefix('Revert "GH-1 x"')).toBeNull();
  });

  it("운영자 사이트가 더 뒤처져도 최신 커밋부터 보이고 잘리지 않는다", () => {
    const commit = (n: number) => ({ sha: sampleSha(n), title: `c${n}` });
    const range = (from: number) =>
      Array.from({ length: 12 - from }, (_, i) => commit(from + i + 1));
    const site = (app: "site" | "admin", from: number): SiteView => ({
      app,
      deployed: { status: "known", value: sampleSha(from), checkedAt: AT },
      detail: { status: "known", value: commit(from), checkedAt: AT },
      changes: {
        status: "known",
        value: {
          from: sampleSha(from),
          to: sampleSha(12),
          files: [],
          commits: range(from),
        },
        checkedAt: AT,
      },
      matchedRun: null,
    });
    // 사용자 사이트 c6~c12, 운영자 사이트 c1~c12
    const list = pendingCommits([site("site", 5), site("admin", 0)]);
    expect(list.total).toBe(12);
    expect(list.commits.map((c) => c.title)).toEqual([
      "c12",
      "c11",
      "c10",
      "c9",
      "c8",
      "c7",
      "c6",
      "c5",
      "c4",
      "c3",
    ]);
    expect(list.compare).toEqual({ from: sampleSha(0), to: sampleSha(12) });
  });

  it("진행 중·승인 대기는 30초, 그 밖은 1분", () => {
    expect(refreshInterval("deploying")).toBe(30_000);
    expect(refreshInterval("approval_pending")).toBe(30_000);
    expect(refreshInterval("ready")).toBe(60_000);
    expect(refreshInterval(null)).toBe(60_000);
  });
});
