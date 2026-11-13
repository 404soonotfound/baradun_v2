import { describe, expect, it } from "vitest";
import type { CollectionView, JobCollection } from "./collection";
import { shellStatus } from "./shell-status";

// 왼쪽 메뉴 아래 상태 칸 (GH-450, 시안 V1·V6·E1)

const job = (
  name: string,
  status: "complete" | "failed" | null,
): JobCollection =>
  ({
    job: name,
    lastRun: status
      ? { startedAt: "2026-11-12T05:00:00Z", status, failures: [] }
      : null,
    lastSuccessAt: null,
    day: { complete: 0, partial: 0, failed: 0 },
    week: { complete: 0, partial: 0, failed: 0 },
    hourly: [],
    incidents: [],
    truncated: false,
    lateAfterMinutes: 45,
    overdue: false,
  }) as unknown as JobCollection;

const view = (
  jobs: JobCollection[],
  publishedAt: string | null = "2026-11-12T05:40:12Z",
): CollectionView =>
  ({
    generatedAt: "2026-11-12T05:42:00Z",
    publishedVersion: null,
    jobs,
    publish:
      publishedAt === null
        ? null
        : {
            version: "20261112T054012Z",
            publishedAt,
            beachCount: 206,
            delayedBeaches: 0,
          },
    alarms: { status: "unavailable" },
    stations: { status: "unavailable" },
  }) as unknown as CollectionView;

describe("shellStatus", () => {
  it("판단 출처가 모두 정상이면 정상 + 게시본 KST 시각(초까지)", () => {
    expect(
      shellStatus(
        view([
          job("collect-warnings", "complete"),
          job("collect-ocean", "complete"),
        ]),
      ),
    ).toEqual({ kind: "ok", problems: 0, published: "14:40:12" });
  });

  it("판단 출처 하나라도 정상이 아니면 문제 수. 응답에 빠진 출처도 문제로 셈", () => {
    expect(
      shellStatus(view([job("collect-warnings", "failed")])),
    ).toMatchObject({ kind: "problem", problems: 2 });
  });

  it("게시본 요약이 없거나 시각을 읽을 수 없으면 게시본만 확인 못 함(null)", () => {
    const ok = [
      job("collect-warnings", "complete"),
      job("collect-ocean", "complete"),
    ];
    expect(shellStatus(view(ok, null))).toMatchObject({ published: null });
    expect(shellStatus(view(ok, "not-a-time"))).toMatchObject({
      published: null,
    });
  });

  it("게시본이 다른 날이면 날짜를 붙임(어제 시각을 오늘로 읽지 않게)", () => {
    const ok = [
      job("collect-warnings", "complete"),
      job("collect-ocean", "complete"),
    ];
    expect(shellStatus(view(ok, "2026-11-11T14:00:00Z"))).toMatchObject({
      published: "11/11 23:00",
    });
  });

  it("수집 현황을 읽지 못하면 '확인 못 함'(정상으로 두지 않음)", () => {
    expect(shellStatus(null)).toEqual({ kind: "unknown" });
  });
});
