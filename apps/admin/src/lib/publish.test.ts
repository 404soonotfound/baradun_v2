import { describe, expect, it } from "vitest";
import {
  canRollBackTo,
  jobInFlight,
  jobPhase,
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
