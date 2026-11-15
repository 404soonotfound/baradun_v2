import { describe, expect, it } from "vitest";
import { localSourcesView } from "./auth/local-sources";
import type { CollectionView } from "./collection";
import {
  keyNames,
  keyState,
  kstClock,
  latestState,
  monthRanges,
  resolveCollectionState,
  scheduleSlots,
  validSources,
  type CollectionSlot,
  type SourcesView,
  type SourceView,
} from "./sources";

const NOW = Date.parse("2026-11-10T06:00:00Z");
const view = (): SourcesView => localSourcesView(NOW);
const source = (patch: Partial<SourceView>): SourceView => ({
  ...view().sources[0]!,
  ...patch,
});

describe("validSources", () => {
  it("서버 모양 그대로면 통과", () => {
    expect(validSources(view())).toBe(true);
  });

  // 첫 출처(해상 특보)만 바꾸고 나머지 4곳은 그대로 둔 응답
  const withFirst = (patch: object) => {
    const base = view();
    return {
      ...base,
      sources: [{ ...base.sources[0], ...patch }, ...base.sources.slice(1)],
    };
  };
  const firstRun = view().sources[0]!.recentRuns![0]!;

  it("칸이 빠지거나 모양이 틀리면 불러오기 실패(빈 목록·기록 없음으로 채우지 않음)", () => {
    const base = view();
    const broken: unknown[] = [
      null,
      { ...base, sources: undefined },
      { ...base, keysHidden: undefined },
      { ...base, http: { timeoutMs: "10s", retries: 1 } },
      withFirst({ recentRuns: undefined }),
      withFirst({ id: "collect-cctv" }),
      withFirst({
        recentRuns: [
          { startedAt: "x", finishedAt: "y", status: "ok", failures: [] },
        ],
      }),
      withFirst({ recentRuns: [{ ...firstRun, startedAt: "x" }] }),
      withFirst({ recentRuns: [{ ...firstRun, missingStations: [22105] }] }),
      withFirst({ recentRuns: [{ ...firstRun, missingStationsTotal: "3" }] }),
      { ...base, generatedAt: "어제" },
      { ...base, keys: [{ ...base.keys[0], status: "expired" }] },
      withFirst({
        schedule: { periodMinutes: 0, offsetMinutes: 3, offSeason: null },
      }),
    ];
    for (const body of broken) expect(validSources(body)).toBe(false);
  });

  it("출처가 비거나 빠지거나(판단 출처 포함) 겹치면 불러오기 실패('0/0 성공'으로 보이지 않게)", () => {
    const base = view();
    expect(validSources({ ...base, sources: [] })).toBe(false);
    expect(validSources({ ...base, sources: base.sources.slice(1) })).toBe(
      false,
    );
    expect(
      validSources({
        ...base,
        sources: [base.sources[1], ...base.sources.slice(1)],
      }),
    ).toBe(false);
  });

  it("최근 실행 null(읽지 못함)·빠진 관측소 칸은 모양이 맞으면 통과", () => {
    expect(validSources(withFirst({ recentRuns: null }))).toBe(true);
    expect(
      validSources(
        withFirst({
          recentRuns: [
            {
              ...firstRun,
              missingStations: ["22105"],
              missingStationsTotal: 3,
            },
          ],
        }),
      ),
    ).toBe(true);
  });
});

describe("latestState", () => {
  it("최신 실행 상태를 그대로", () => {
    expect(latestState(view().sources[1]!)).toBe("partial");
  });
  it("빈 배열은 기록 없음, null은 확인 못 함(정상으로 보지 않음)", () => {
    expect(latestState(source({ recentRuns: [] }))).toBe("none");
    expect(latestState(source({ recentRuns: null }))).toBe("unknown");
  });
  it("읽지 못한 기록이 있으면 최신이 성공이어도 확인 못 함", () => {
    expect(latestState(source({ unreadableRuns: 1 }))).toBe("unknown");
  });
});

describe("수집 시각(KST)", () => {
  it("한 시간 안 여러 번이면 분만", () => {
    expect(
      scheduleSlots({ periodMinutes: 15, offsetMinutes: 3, offSeason: null }),
    ).toEqual([":03", ":18", ":33", ":48"]);
    expect(
      scheduleSlots({ periodMinutes: 60, offsetMinutes: 15, offSeason: null }),
    ).toEqual([":15"]);
  });
  it("매시 같은 분이 아닌 주기는 하루 시각으로", () => {
    expect(
      scheduleSlots({ periodMinutes: 45, offsetMinutes: 0, offSeason: null }),
    ).toHaveLength(32);
    expect(
      scheduleSlots({ periodMinutes: 360, offsetMinutes: 0, offSeason: null }),
    ).toEqual(["03:00", "09:00", "15:00", "21:00"]);
  });
  it("하루 1회는 UTC 격자를 KST 시각으로", () => {
    expect(
      scheduleSlots({
        periodMinutes: 1440,
        offsetMinutes: 19 * 60 + 20,
        offSeason: null,
      }),
    ).toEqual(["04:20"]);
    expect(kstClock(19 * 60 + 12)).toBe("04:12");
    expect(kstClock(0)).toBe("09:00");
  });
});

describe("monthRanges", () => {
  it("이어지는 달은 한 구간, 끊기면 나누고, 12월·1월은 해를 넘는 한 구간", () => {
    expect(monthRanges([6, 7, 8, 9])).toEqual([[6, 9]]);
    expect(monthRanges([6, 8])).toEqual([
      [6, 6],
      [8, 8],
    ]);
    expect(monthRanges([11, 12, 1, 2])).toEqual([[11, 2]]);
    expect(monthRanges([1, 6, 12])).toEqual([
      [6, 6],
      [12, 1],
    ]);
  });
});

describe("keyNames", () => {
  it("출처들이 쓰는 키 이름을 한 번씩", () => {
    expect(keyNames(view())).toEqual(["data-go-kr", "kma-apihub"]);
  });
});

describe("keyState", () => {
  const withKey = (patch: object, hidden = false): SourcesView => {
    const base = view();
    return {
      ...base,
      keysHidden: hidden,
      keys: hidden ? [] : [{ ...base.keys[0]!, ...patch }],
    };
  };
  it("등록·만료 지남·형식 오류·만료일 없음을 나눔", () => {
    expect(keyState(withKey({}), "data-go-kr")).toBe("registered");
    expect(keyState(withKey({ daysLeft: 0 }), "data-go-kr")).toBe("registered");
    expect(keyState(withKey({ daysLeft: -1 }), "data-go-kr")).toBe("expired");
    expect(
      keyState(
        withKey({ expiresOn: null, daysLeft: null, expiresInvalid: true }),
        "data-go-kr",
      ),
    ).toBe("invalid");
    expect(
      keyState(withKey({ expiresOn: null, daysLeft: null }), "data-go-kr"),
    ).toBe("noExpiry");
  });
  it("확인 못 함·응답에 없는 키는 '등록 안 됨'이 아니라 확인 못 함", () => {
    expect(keyState(withKey({ status: "unknown" }), "data-go-kr")).toBe(
      "unknown",
    );
    expect(keyState(withKey({}), "kma-apihub")).toBe("unknown");
    expect(keyState(withKey({ status: "missing" }), "data-go-kr")).toBe(
      "missing",
    );
  });
  it("샘플 계정은 보여 주지 않음", () => {
    expect(keyState(withKey({}, true), "data-go-kr")).toBe("hidden");
  });
});

describe("resolveCollectionState", () => {
  const sampleView = {
    generatedAt: "2026-11-10T06:00:00Z",
  } as unknown as CollectionView;

  it("로그아웃 상태면 값도 자리표시도 비움", () => {
    const slot: CollectionSlot = {
      key: "0|1",
      generation: 1,
      view: sampleView,
    };
    expect(
      resolveCollectionState(slot, {
        signedIn: false,
        generation: 1,
        key: "0|1",
      }),
    ).toEqual({ view: null, pending: false });
  });

  it("첫 읽기와 다시 읽기·실패 뒤 재시도 분기를 구분함", () => {
    expect(
      resolveCollectionState(null, {
        signedIn: true,
        generation: 1,
        key: "0|1",
      }),
    ).toEqual({ view: null, pending: true });

    const okSlot: CollectionSlot = {
      key: "0|1",
      generation: 1,
      view: sampleView,
    };
    expect(
      resolveCollectionState(okSlot, {
        signedIn: true,
        generation: 1,
        key: "0|1",
      }),
    ).toEqual({ view: sampleView, pending: false });

    // 성공 뒤 새로 고침 중에는 직전 값을 유지하고 자리표시로 덮지 않음(D16-E1)
    expect(
      resolveCollectionState(okSlot, {
        signedIn: true,
        generation: 1,
        key: "1|1",
      }),
    ).toEqual({ view: sampleView, pending: false });

    // 실패로 끝난 뒤(null) 다시 새로 고침하면 자리표시로 전환
    const failedSlot: CollectionSlot = {
      key: "1|1",
      generation: 1,
      view: null,
    };
    expect(
      resolveCollectionState(failedSlot, {
        signedIn: true,
        generation: 1,
        key: "1|1",
      }),
    ).toEqual({ view: null, pending: false });
    expect(
      resolveCollectionState(failedSlot, {
        signedIn: true,
        generation: 1,
        key: "2|1",
      }),
    ).toEqual({ view: null, pending: true });

    // 세션 generation이 바뀌면 이전 세션 값을 지우고 다시 읽음
    expect(
      resolveCollectionState(okSlot, {
        signedIn: true,
        generation: 2,
        key: "0|2",
      }),
    ).toEqual({ view: null, pending: true });
  });
});
