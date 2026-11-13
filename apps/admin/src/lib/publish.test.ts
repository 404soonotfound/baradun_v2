import { describe, expect, it } from "vitest";
import { pageRows, pageWindow } from "./paging";
import {
  canRollBackTo,
  hasHeldNotices,
  isRunSkipped,
  jobInFlight,
  jobPhase,
  nonZeroCategoryDeltas,
  parseAppSettings,
  pendingNoticeDiff,
  reasonKey,
  signed,
  versionIso,
  type JobView,
} from "./publish";

// 데이터 게시 화면의 문구 고르기 (#331, ADM-PUB). 게시 판단은 하지 않고 서버 값을 화면 단계로만 옮김

const job = (overrides: Partial<JobView> = {}): JobView => ({
  jobId: "j-0123456789ab",
  action: "publish",
  state: "pending",
  createdAt: "2026-11-12T06:00:00Z",
  overdue: false,
  ...overrides,
});

describe("jobPhase", () => {
  it("대기·실행·게시 완료·변경 없음·실패를 나눈다", () => {
    expect(jobPhase(job())).toBe("requested");
    expect(jobPhase(job({ state: "running" }))).toBe("running");
    expect(jobPhase(job({ state: "done", result: "published" }))).toBe(
      "published",
    );
    expect(jobPhase(job({ state: "done", result: "unchanged" }))).toBe(
      "unchanged",
    );
    expect(jobPhase(job({ state: "failed", reason: "beach_ids" }))).toBe(
      "failed",
    );
  });

  it("늦어진 작업은 실패가 아니라 '결과 확인 못 함'(D16-C4)", () => {
    expect(jobPhase(job({ state: "running", overdue: true }))).toBe("overdue");
    expect(jobPhase(job({ state: "pending", overdue: true }))).toBe("overdue");
  });

  it("게시 기록으로 찾은 결과와 모르는 상태를 구분한다", () => {
    expect(
      jobPhase(
        job({ state: "done", result: "published", fromRunRecord: true }),
      ),
    ).toBe("recovered");
    expect(jobPhase(job({ state: "weird" }))).toBe("unknown");
    expect(jobPhase(job({ state: "done", result: "weird" }))).toBe("unknown");
  });
});

describe("jobInFlight", () => {
  it("끝나지 않았고 늦어지지 않은 작업만 진행 중으로 본다", () => {
    expect(jobInFlight(job())).toBe(true);
    expect(jobInFlight(job({ state: "running" }))).toBe(true);
    expect(jobInFlight(job({ state: "running", overdue: true }))).toBe(false);
    expect(jobInFlight(job({ state: "done", result: "published" }))).toBe(
      false,
    );
    expect(jobInFlight(null)).toBe(false);
  });
});

describe("canRollBackTo", () => {
  const item = { version: "20261112T050000Z", at: "", source: "auto" };
  it("게시된 기록 중 지금 게시본이 아닌 것만", () => {
    expect(
      canRollBackTo({ ...item, result: "published" }, "20261112T060000Z"),
    ).toBe(true);
    expect(
      canRollBackTo({ ...item, result: "published" }, "20261112T050000Z"),
    ).toBe(false);
    expect(canRollBackTo({ ...item, result: "failed" }, null)).toBe(false);
  });
});

describe("reasonKey", () => {
  it("알려진 사유는 문구 키로, 처리 중 예외는 하나로, 모르는 사유는 null(code를 그대로 보임)", () => {
    expect(reasonKey("beach_ids")).toBe("beach_ids");
    expect(reasonKey("manifest_conflict")).toBe("overlap");
    expect(reasonKey("rollback_target_invalid")).toBe("rollback_target");
    expect(reasonKey("exception:TypeError")).toBe("exception");
    expect(reasonKey("brand_new")).toBeNull();
    expect(reasonKey(undefined)).toBeNull();
  });
});

describe("signed · versionIso", () => {
  it("증감을 부호와 함께, 게시 버전을 UTC 시각으로", () => {
    expect(signed(3)).toBe("+3");
    expect(signed(-2)).toBe("−2");
    expect(signed(0)).toBe("0");
    expect(versionIso("20261112T054500Z")).toBe("2026-11-12T05:45:00Z");
    expect(versionIso("2026-11-12")).toBeNull();
  });
});

describe("nonZeroCategoryDeltas", () => {
  it("0이 아닌 상태 개수 차이만 부호와 함께 돌려주고 null이면 빈 배열", () => {
    expect(
      nonZeroCategoryDeltas({ clear: -3, unavailable: 3, undetermined: 0 }),
    ).toEqual([
      { category: "clear", delta: -3, signed: "−3" },
      { category: "unavailable", delta: 3, signed: "+3" },
    ]);
    expect(
      nonZeroCategoryDeltas({ clear: 0, unavailable: 0, undetermined: 0 }),
    ).toEqual([]);
    expect(nonZeroCategoryDeltas(null)).toEqual([]);
  });
});

describe("isRunSkipped · hasHeldNotices", () => {
  it("바뀐 게 없어 건너뛴 실행과 되돌림 상태 공지 유무를 판정한다", () => {
    expect(
      isRunSkipped({
        at: "2026-11-12T06:00:00Z",
        source: "auto",
        result: "unchanged",
        version: "20261112T060000Z",
      }),
    ).toBe(true);
    expect(
      isRunSkipped({
        at: "2026-11-12T06:00:00Z",
        source: "auto",
        result: "published",
        version: "20261112T060000Z",
      }),
    ).toBe(false);
    expect(isRunSkipped(null)).toBe(false);

    expect(
      hasHeldNotices({
        ok: true,
        version: 2,
        items: [
          {
            id: "n-1",
            title: "안내",
            target: "20261112T050000Z",
            at: "2026-11-12T05:30:00Z",
            restoresLive: false,
          },
        ],
      }),
    ).toBe(true);
    expect(hasHeldNotices({ ok: true, version: 0, items: [] })).toBe(false);
    expect(hasHeldNotices({ ok: false })).toBe(false);
  });
});

describe("pendingNoticeDiff", () => {
  it("실제 공지 필드로 추가·삭제 줄을 만든다", () => {
    const added = pendingNoticeDiff(
      {
        id: "n-1",
        change: "add",
        kind: "general",
        title: "안내",
        startsAt: "2026-11-12T06:00:00Z",
        endsAt: null,
      },
      "일반 공지",
      (iso) => iso,
      "종료 없음",
    );
    expect(added.added).toBe(4);
    expect(added.removed).toBe(0);
    expect(added.lines[0]).toEqual({
      beforeLine: null,
      afterLine: 1,
      kind: "add",
      text: "kind: 일반 공지",
    });

    const removed = pendingNoticeDiff(
      {
        id: "n-2",
        change: "remove",
        kind: "maintenance_notice",
        title: "점검",
        startsAt: "2026-11-12T06:00:00Z",
        endsAt: "2026-11-12T07:00:00Z",
      },
      "점검 예고",
      (iso) => iso,
      "종료 없음",
    );
    expect(removed.added).toBe(0);
    expect(removed.removed).toBe(4);
    expect(removed.lines[3]?.kind).toBe("del");
  });
});

describe("게시 기록 페이징", () => {
  it("한 쪽 5행 기준으로 범위를 계산하고 마지막 쪽을 넘기지 않는다", () => {
    const rows = Array.from({ length: 12 }, (_, i) => i + 1);
    expect(pageWindow(rows.length, 0)).toEqual({
      page: 0,
      pages: 3,
      from: 1,
      to: 5,
      atStart: true,
      atEnd: false,
    });
    expect(pageRows(rows, 1)).toEqual([6, 7, 8, 9, 10]);
    expect(pageRows(rows, 2)).toEqual([11, 12]);
    expect(pageWindow(rows.length, 9)).toMatchObject({
      page: 2,
      from: 11,
      to: 12,
      atEnd: true,
    });
  });
});

describe("parseAppSettings", () => {
  it("응답에 settings가 없으면 absent, 있는데 비거나 형식이 틀리면 invalid, 올바르면 ok", () => {
    expect(parseAppSettings(undefined)).toEqual({ kind: "absent" });
    expect(parseAppSettings(null)).toEqual({ kind: "invalid" });
    expect(parseAppSettings({})).toEqual({ kind: "invalid" });
    expect(
      parseAppSettings({ maintenance: { active: false }, minWebBuild: 0 }),
    ).toEqual({ kind: "invalid" });
    expect(
      parseAppSettings({
        maintenance: { active: true, until: "2026-11-14T06:00:00Z" },
        minWebBuild: 1,
      }),
    ).toEqual({
      kind: "ok",
      value: {
        maintenance: { active: true, until: "2026-11-14T06:00:00Z" },
        minWebBuild: 1,
      },
    });
  });
});
