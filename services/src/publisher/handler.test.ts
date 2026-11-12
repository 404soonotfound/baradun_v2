import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadBeaches } from "../core/beaches/load";
import { MemoryOpsStore } from "../core/store/memory";
import {
  isPublishFault,
  jobOutcomeOf,
  parseManualEvent,
  runPublishJob,
} from "./handler";
import { beachIdProblem } from "./publish";
import { parseBeachMeta } from "./season";
import { contractErrors } from "./validate";

// publisher 진입점의 해변 파일 읽기 (BRD-61 PR ②)
// Lambda에서는 묶을 때 복사한 beaches/ 폴더를 읽음. 시험은 저장소 data/beaches를 그대로 씀

const beachesDir = fileURLToPath(
  new URL("../../../data/beaches/", import.meta.url),
);

// 게시 전 해변 ID 대조(D16-C1)의 두 입력: 묶을 때 폴더째 복사한 해변 파일과 JSON으로 묶인 beach-meta.json
// 저장소에서 둘이 어긋나면 배포 뒤 모든 게시가 멈추므로(앞 게시본 유지) 여기서 먼저 잡음
describe("저장소 원본 해변 ID 목록", () => {
  it("data/beach-meta.json의 해변 칸과 data/beaches 파일의 id가 집합으로 같다", () => {
    const meta = JSON.parse(
      readFileSync(
        new URL("../../../data/beach-meta.json", import.meta.url),
        "utf8",
      ),
    ) as unknown;
    expect(
      beachIdProblem(
        parseBeachMeta(meta).beachIds,
        loadBeaches(beachesDir).map((beach) => beach.id),
      ),
    ).toBeNull();
  });
});

// 사람이 직접 부르는 이벤트(되돌리기·다시 내보내기, 결정 기록 D20-1~4)
describe("parseManualEvent", () => {
  const version = "20261017T053000Z";

  it("action이 없는 이벤트(수집기가 깨운 실행)는 자동 게시", () => {
    expect(parseManualEvent(undefined)).toBeNull();
    expect(parseManualEvent({})).toBeNull();
    expect(parseManualEvent({ version })).toBeNull();
  });

  it("되돌리기·다시 내보내기를 버전과 함께 받는다", () => {
    expect(parseManualEvent({ action: "rollback", version })).toEqual({
      action: "rollback",
      version,
    });
    expect(parseManualEvent({ action: "republish", version })).toEqual({
      action: "republish",
      version,
    });
  });

  it.each([
    ["오타 난 action", { action: "rolback", version }],
    ["action이 글자가 아님", { action: 1, version }],
    ["버전 없음", { action: "rollback" }],
    ["버전 형식 다름", { action: "rollback", version: "2026-10-17" }],
    [
      "버전 뒤에 글자가 더 붙음",
      { action: "republish", version: `${version}x` },
    ],
  ])("%s이면 보통 게시로 돌리지 않고 던진다", (_name, event) => {
    expect(() => parseManualEvent(event)).toThrow();
  });
});

// 운영 API가 부르는 작업 이벤트(#331)
describe("parseManualEvent 운영자 게시 작업", () => {
  const version = "20261017T053000Z";
  const jobId = "j-0123456789ab";

  it("지금 게시는 작업 ID와 함께 받는다", () => {
    expect(parseManualEvent({ action: "publish", jobId })).toEqual({
      action: "publish",
      jobId,
    });
  });

  it("되돌리기는 작업 ID가 있어도 없어도 받는다(명령줄 되돌리기는 작업 없음)", () => {
    expect(parseManualEvent({ action: "rollback", version, jobId })).toEqual({
      action: "rollback",
      version,
      jobId,
    });
  });

  it.each([
    ["작업 ID 없는 지금 게시", { action: "publish" }],
    ["작업 ID 형식 틀림", { action: "publish", jobId: "j-xyz" }],
    ["작업 ID가 글자가 아님", { action: "rollback", version, jobId: 1 }],
    ["다시 내보내기에 작업 ID", { action: "republish", version, jobId }],
  ])("%s이면 던진다", (_name, event) => {
    expect(() => parseManualEvent(event)).toThrow();
  });
});

describe("runPublishJob", () => {
  const NOW = Date.parse("2026-11-12T06:00:00Z");
  const log = () => undefined;
  function store(state: "pending" | "running" | "done", createdAtMs = NOW) {
    const ops = new MemoryOpsStore();
    ops.jobs.set("j-0123456789ab", {
      jobId: "j-0123456789ab",
      action: "publish",
      state,
      createdAt: new Date(createdAtMs).toISOString(),
      createdAtMs,
    });
    return ops;
  }

  it("대기 작업을 맡아 게시하고 결과(게시 완료)를 작업에 남긴다", async () => {
    const ops = store("pending");
    let runs = 0;
    const result = await runPublishJob(
      { ops, clock: () => NOW, log },
      "j-0123456789ab",
      async () => {
        runs++;
        return {
          status: "published",
          version: "20261112T060000Z",
          removed: [],
        };
      },
    );
    expect(result.status).toBe("published");
    expect(runs).toBe(1);
    expect(ops.jobs.get("j-0123456789ab")).toMatchObject({
      state: "done",
      result: "published",
      snapshotVersion: "20261112T060000Z",
      startedAt: "2026-11-12T06:00:00.000Z",
    });
  });

  it("같은 작업 호출이 두 번 와도 한 번만 게시한다", async () => {
    const ops = store("pending");
    let runs = 0;
    const run = async () => {
      runs++;
      return { status: "unchanged", version: "20261112T054500Z" } as const;
    };
    await runPublishJob({ ops, clock: () => NOW, log }, "j-0123456789ab", run);
    const second = await runPublishJob(
      { ops, clock: () => NOW, log },
      "j-0123456789ab",
      run,
    );
    expect(second).toEqual({ status: "busy" });
    expect(runs).toBe(1);
    expect(ops.jobs.get("j-0123456789ab")).toMatchObject({
      state: "done",
      result: "unchanged",
    });
  });

  it("시작 제한이 지난 대기 작업은 게시하지 않고 실패(expired)로 바꾼다(늦게 온 호출)", async () => {
    const ops = store("pending", NOW - 10 * 60 * 1000);
    let runs = 0;
    const result = await runPublishJob(
      { ops, clock: () => NOW, log },
      "j-0123456789ab",
      async () => {
        runs++;
        return { status: "busy" } as const;
      },
    );
    expect(result).toEqual({ status: "busy" });
    expect(runs).toBe(0);
    expect(ops.jobs.get("j-0123456789ab")).toMatchObject({
      state: "failed",
      reason: "expired",
    });
  });

  it("게시가 예외를 던지면 작업을 실패로 남기고 예외를 그대로 던진다", async () => {
    const ops = store("pending");
    await expect(
      runPublishJob({ ops, clock: () => NOW, log }, "j-0123456789ab", () =>
        Promise.reject(new TypeError("boom")),
      ),
    ).rejects.toThrow("boom");
    expect(ops.jobs.get("j-0123456789ab")).toMatchObject({
      state: "failed",
      reason: "exception:TypeError",
    });
  });

  it("작업 결과를 남기지 못해도 게시 결과는 그대로 돌려준다", async () => {
    const ops = store("pending");
    ops.finishPublishJob = async () => {
      throw new Error("throttled");
    };
    const result = await runPublishJob(
      { ops, clock: () => NOW, log },
      "j-0123456789ab",
      async () => ({
        status: "published",
        version: "20261112T060000Z",
        removed: [],
      }),
    );
    expect(result.status).toBe("published");
  });
});

describe("jobOutcomeOf", () => {
  it("물러남(busy)은 이 작업이 게시하지 않은 것이라 실패(busy), 실패는 사유와 시도한 버전", () => {
    expect(jobOutcomeOf({ status: "busy" })).toEqual({
      state: "failed",
      reason: "busy",
    });
    expect(
      jobOutcomeOf({
        status: "failed",
        version: "20261112T060000Z",
        reason: "beach_ids",
      }),
    ).toEqual({
      state: "failed",
      reason: "beach_ids",
      snapshotVersion: "20261112T060000Z",
    });
    expect(
      jobOutcomeOf({ status: "unchanged", version: "20261112T054500Z" }),
    ).toEqual({
      state: "done",
      result: "unchanged",
      snapshotVersion: "20261112T054500Z",
    });
  });
});

// 오류로 던져 게시 오류 알림(PublishErrors)으로 보낼 결과인지(D16-C2)
describe("isPublishFault", () => {
  const version = "20261017T053000Z";
  const failed = (reason: string) =>
    ({ status: "failed", version, reason }) as const;
  const rollback = { action: "rollback", version } as const;
  const republish = { action: "republish", version } as const;

  it("자동 게시의 실패는 모두 던진다", () => {
    expect(isPublishFault(null, failed("beach_ids"))).toBe(true);
    expect(isPublishFault(null, failed("contract"))).toBe(true);
    // 자동 게시에서는 생기지 않는 사유지만, 생겼다면 숨기지 않음
    expect(isPublishFault(null, failed("manifest_missing"))).toBe(true);
  });

  it("사람이 부른 실행의 입력 문제는 던지지 않고 결과로 돌려준다", () => {
    for (const reason of [
      "rollback_target_missing",
      "rollback_target_invalid",
    ]) {
      expect(isPublishFault(rollback, failed(reason))).toBe(false);
    }
    for (const reason of [
      "manifest_missing",
      "files_missing",
      "files_mismatch",
      "policy_unsupported",
    ]) {
      expect(isPublishFault(republish, failed(reason))).toBe(false);
    }
  });

  it("사람이 부른 실행이어도 게시 장애는 던진다", () => {
    for (const reason of [
      "beach_ids",
      "classify",
      "contract",
      "hold_conflict",
      "manifest_conflict",
      "exception:Error",
    ]) {
      expect(isPublishFault(rollback, failed(reason))).toBe(true);
    }
  });

  it("게시됨·변경 없음·물러남은 던지지 않는다", () => {
    expect(
      isPublishFault(null, { status: "published", version, removed: [] }),
    ).toBe(false);
    expect(isPublishFault(rollback, { status: "unchanged", version })).toBe(
      false,
    );
    expect(isPublishFault(null, { status: "busy" })).toBe(false);
  });
});

describe("loadBeaches", () => {
  it("b0000.json 모양 파일만 id 순서로 읽고, 계약(BeachesFile)을 통과함", () => {
    const beaches = loadBeaches(beachesDir);
    expect(beaches.length).toBeGreaterThan(0);
    expect(beaches.map((b) => b.id)).toEqual(
      [...beaches.map((b) => b.id)].sort(),
    );
    expect(contractErrors("BeachesFile", { beaches })).toEqual([]);
  });

  it("README 같은 다른 파일은 읽지 않음", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "beaches-"));
    writeFileSync(path.join(dir, "README.md"), "# x");
    writeFileSync(path.join(dir, "b0001.json"), '{"id":"b0001"}');
    expect(loadBeaches(dir)).toEqual([{ id: "b0001" }]);
  });

  it("해변 파일이 하나도 없으면 빈 목록으로 게시하지 않고 던짐", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "beaches-"));
    writeFileSync(path.join(dir, "README.md"), "# x");
    expect(() => loadBeaches(dir)).toThrow("해변 파일 없음");
  });
});
