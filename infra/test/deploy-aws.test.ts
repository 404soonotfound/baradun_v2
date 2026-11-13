import { describe, expect, it } from "vitest";
import {
  checkFunctionLogs,
  failedEventsOrNull,
  readChangeSetPages,
  readRemotePolicy,
  waitWhileInProgress,
  type AwsRunner,
  type RunResult,
} from "../scripts/deploy-aws";

// 로컬·CI 배포 명령이 함께 쓰는 AWS 조회 (#418). 가짜 실행기로 결과 종류를 확인함

const ok = (body: unknown): RunResult => ({
  status: 0,
  stdout: JSON.stringify(body),
  stderr: "",
});
const err = (stderr: string): RunResult => ({
  status: 254,
  stdout: "",
  stderr,
});

// 하위 명령(앞 두 인자)마다 차례로 돌려줄 결과
function fake(responses: Record<string, RunResult[]>) {
  const calls: string[][] = [];
  const runner: AwsRunner = (args) => {
    calls.push([...args]);
    const key = `${args[0]} ${args[1]}`;
    const next = responses[key]?.shift();
    if (!next) throw new Error(`예상하지 못한 호출: ${args.join(" ")}`);
    return next;
  };
  return { runner, calls };
}

describe("스택 밖 정책 읽기", () => {
  it("기본 버전 문서를 읽고, 문자열(URL 인코딩)로 오면 풀어 준다", () => {
    const doc = { Version: "2012-10-17", Statement: [] };
    const { runner } = fake({
      "iam get-policy": [ok({ Policy: { DefaultVersionId: "v5" } })],
      "iam get-policy-version": [
        ok({
          PolicyVersion: {
            Document: encodeURIComponent(JSON.stringify(doc)),
          },
        }),
      ],
    });
    expect(readRemotePolicy(runner, "arn:p")).toEqual({
      kind: "ok",
      version: "v5",
      doc,
    });
  });

  it("없음(NoSuchEntity)과 조회 실패를 나눈다(권한 오류를 '없음'으로 보지 않음)", () => {
    expect(
      readRemotePolicy(
        fake({ "iam get-policy": [err("An error occurred (NoSuchEntity)")] })
          .runner,
        "arn:p",
      ),
    ).toEqual({ kind: "missing" });
    expect(
      readRemotePolicy(
        fake({ "iam get-policy": [err("AccessDenied")] }).runner,
        "arn:p",
      ),
    ).toEqual({ kind: "error", stderr: "AccessDenied" });
    expect(
      readRemotePolicy(
        fake({
          "iam get-policy": [ok({ Policy: { DefaultVersionId: "v5" } })],
          "iam get-policy-version": [err("ExpiredToken")],
        }).runner,
        "arn:p",
      ).kind,
    ).toBe("error");
  });
});

describe("변경 세트 읽기", () => {
  const change = (id: string) => ({
    ResourceChange: { LogicalResourceId: id },
  });

  it("다음 쪽까지 모두 모은다", () => {
    const { runner, calls } = fake({
      "cloudformation describe-change-set": [
        ok({
          Status: "CREATE_COMPLETE",
          Changes: [change("A")],
          NextToken: "t1",
        }),
        ok({ Changes: [change("B")] }),
      ],
    });
    const got = readChangeSetPages(runner, "BaradunV2", "deploy-x");
    expect(got.kind).toBe("ok");
    if (got.kind === "ok") {
      expect(
        got.changes.map((c) => c.ResourceChange?.LogicalResourceId),
      ).toEqual(["A", "B"]);
      expect(got.changeSet.Status).toBe("CREATE_COMPLETE");
    }
    expect(calls[1]).toContain("--next-token");
  });

  it("없음(ChangeSetNotFound)만 missing, 중간 쪽 실패는 일부 행으로 판정하지 않고 error", () => {
    expect(
      readChangeSetPages(
        fake({
          "cloudformation describe-change-set": [
            err("ChangeSetNotFound: deploy-x"),
          ],
        }).runner,
        "BaradunV2",
        "deploy-x",
      ),
    ).toEqual({ kind: "missing" });
    expect(
      readChangeSetPages(
        fake({
          "cloudformation describe-change-set": [
            ok({ Changes: [change("A")], NextToken: "t1" }),
            err("Throttling"),
          ],
        }).runner,
        "BaradunV2",
        "deploy-x",
      ),
    ).toEqual({ kind: "error", stderr: "Throttling" });
  });
});

describe("다른 배포가 진행 중일 때 (CI)", () => {
  const stacks = (status: string) => ok({ Stacks: [{ StackStatus: status }] });

  it("진행 중(가져오기·롤백 포함)이면 정해진 간격으로 상태를 다시 읽어 끝난 상태를 돌려준다", () => {
    const slept: number[] = [];
    const { runner, calls } = fake({
      "cloudformation describe-stacks": [
        stacks("UPDATE_IN_PROGRESS"),
        stacks("IMPORT_IN_PROGRESS"),
        stacks("UPDATE_ROLLBACK_COMPLETE"),
      ],
    });
    expect(
      waitWhileInProgress(runner, "BaradunV2", {
        pollMs: 10,
        sleep: (ms) => slept.push(ms),
      }),
    ).toBe("UPDATE_ROLLBACK_COMPLETE");
    expect(slept).toEqual([10, 10]);
    // 업데이트 외 상태에서 끝나지 않는 waiter는 쓰지 않음
    expect(calls.every((c) => c[1] === "describe-stacks")).toBe(true);
  });

  it("상한을 넘겨도 진행 중이면 그 상태를 돌려준다(부르는 쪽이 멈춤)", () => {
    const { runner } = fake({
      "cloudformation describe-stacks": [
        stacks("UPDATE_IN_PROGRESS"),
        stacks("UPDATE_IN_PROGRESS"),
        stacks("UPDATE_IN_PROGRESS"),
      ],
    });
    expect(
      waitWhileInProgress(runner, "BaradunV2", {
        maxWaitMs: 20,
        pollMs: 10,
        sleep: () => {},
      }),
    ).toBe("UPDATE_IN_PROGRESS");
  });

  it("진행 중이 아니면 기다리지 않고, 읽지 못하면 null", () => {
    const { runner, calls } = fake({
      "cloudformation describe-stacks": [stacks("UPDATE_COMPLETE")],
    });
    expect(waitWhileInProgress(runner, "BaradunV2")).toBe("UPDATE_COMPLETE");
    expect(calls).toHaveLength(1);
    expect(
      waitWhileInProgress(
        fake({ "cloudformation describe-stacks": [err("ExpiredToken")] })
          .runner,
        "BaradunV2",
      ),
    ).toBeNull();
  });
});

describe("실패 이벤트", () => {
  it("읽지 못하면 null('실패 없음'과 나눔), 읽으면 이번 실행 뒤 실패만", () => {
    expect(
      failedEventsOrNull(
        fake({ "cloudformation describe-stack-events": [err("ExpiredToken")] })
          .runner,
        "BaradunV2",
        new Date("2026-11-13T00:00:00Z"),
      ),
    ).toBeNull();
    const events = failedEventsOrNull(
      fake({
        "cloudformation describe-stack-events": [
          ok({
            StackEvents: [
              {
                Timestamp: "2026-11-13T00:05:00Z",
                LogicalResourceId: "Fn",
                ResourceStatus: "UPDATE_FAILED",
              },
              {
                Timestamp: "2026-11-12T00:05:00Z",
                LogicalResourceId: "Old",
                ResourceStatus: "UPDATE_FAILED",
              },
            ],
          }),
        ],
      }).runner,
      "BaradunV2",
      new Date("2026-11-13T00:00:00Z"),
    );
    expect(events?.map((e) => e.LogicalResourceId)).toEqual(["Fn"]);
  });
});

describe("배포 뒤 로그 점검", () => {
  it("함수 이름·로그 그룹을 찾아 배포 뒤 로그를 세고, 읽지 못한 함수는 error로 남긴다", () => {
    const { runner, calls } = fake({
      "cloudformation describe-stack-resource": [
        ok({ StackResourceDetail: { PhysicalResourceId: "BaradunV2-Ops" } }),
        err("AccessDenied: describe"),
      ],
      "lambda get-function-configuration": [
        ok({ LoggingConfig: { LogGroup: "BaradunV2-OpsLogs" } }),
      ],
      "logs filter-log-events": [
        ok({
          events: [{ message: "START RequestId: 1" }],
          NextToken: "more",
        }),
      ],
    });
    const checks = checkFunctionLogs(
      runner,
      "BaradunV2",
      ["OpsFn", "BrokenFn"],
      1_000,
      20_000,
    );
    expect(checks[0]?.logicalId).toBe("OpsFn");
    expect(checks[0]?.scan?.invocations).toBe(1);
    expect(checks[0]?.truncated).toBe(true);
    expect(checks[1]).toEqual({
      logicalId: "BrokenFn",
      error: "AccessDenied: describe",
    });
    const logCall = calls.find((c) => c[1] === "filter-log-events")!;
    expect(logCall).toEqual(
      expect.arrayContaining([
        "--log-group-name",
        "BaradunV2-OpsLogs",
        "--start-time",
        "1000",
        "--max-items",
        "20000",
      ]),
    );
  });
});
