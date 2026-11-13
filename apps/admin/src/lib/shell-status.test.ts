import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  fetchCollection,
  type CollectionView,
  type JobCollection,
} from "./collection";
import {
  STATUS_FRESH_MS,
  resetShellStatus,
  shellStatus,
  watchShellStatus,
} from "./shell-status";

// 운영 API 호출만 가짜로 바꾸고 계산 함수(kstClock 등)는 그대로 씀
vi.mock("./collection", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./collection")>()),
  fetchCollection: vi.fn(),
}));

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

describe("watchShellStatus", () => {
  const fetchMock = vi.mocked(fetchCollection);
  const token = async () => "token";

  // 시험은 node 환경이라 탭 보임 상태만 흉내 냄
  const doc = new EventTarget() as EventTarget & { hidden: boolean };

  beforeEach(() => {
    doc.hidden = false;
    vi.stubGlobal("document", doc);
    vi.useFakeTimers();
    resetShellStatus();
    fetchMock.mockReset();
    // 응답에 1초 걸리는 수집 현황
    fetchMock.mockImplementation(
      () =>
        new Promise((resolve) =>
          setTimeout(
            () =>
              resolve({
                ok: true,
                status: 200,
                body: { ...view([]), legacy: false },
              } as Awaited<ReturnType<typeof fetchCollection>>),
            1_000,
          ),
        ),
    );
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("한 화면에 머물면 응답 시간과 상관없이 1분마다 다시 읽음(Codex P2: 2분 간격이 되지 않게)", async () => {
    const stop = watchShellStatus("operator:a", token);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(STATUS_FRESH_MS);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(STATUS_FRESH_MS);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    stop();
    await vi.advanceTimersByTimeAsync(STATUS_FRESH_MS);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("화면을 옮겨 새로 시작할 때는 1분 안에 읽은 값이 있으면 다시 부르지 않음", async () => {
    const first = watchShellStatus("operator:a", token);
    await vi.advanceTimersByTimeAsync(2_000);
    first();
    const second = watchShellStatus("operator:a", token);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // 재확인은 새로 시작한 때가 아니라 앞 값(1초에 응답)이 1분 되는 때
    await vi.advanceTimersByTimeAsync(STATUS_FRESH_MS - 1_000 - 1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    second();
    await vi.advanceTimersByTimeAsync(1_000);
    // 다른 계정은 캐시를 쓰지 않음
    const other = watchShellStatus("operator:b", token);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    other();
  });

  it("탭이 숨겨진 동안은 부르지 않고, 다시 보이면 묵은 값만 바로 읽음", async () => {
    const stop = watchShellStatus("operator:a", token);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    doc.hidden = true;
    await vi.advanceTimersByTimeAsync(STATUS_FRESH_MS * 3);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    doc.hidden = false;
    doc.dispatchEvent(new Event("visibilitychange"));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // 방금 읽었으면 다시 보여도 부르지 않음
    await vi.advanceTimersByTimeAsync(2_000);
    doc.hidden = true;
    doc.dispatchEvent(new Event("visibilitychange"));
    doc.hidden = false;
    doc.dispatchEvent(new Event("visibilitychange"));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    stop();
  });
});
