import { describe, expect, it } from "vitest";
import { localSourcesView } from "./auth/local-sources";
import {
  keyState,
  kstClock,
  latestState,
  scheduleSlots,
  validSources,
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

  it("칸이 빠지거나 모양이 틀리면 불러오기 실패(빈 목록·기록 없음으로 채우지 않음)", () => {
    const base = view();
    const broken: unknown[] = [
      null,
      { ...base, sources: undefined },
      { ...base, keysHidden: undefined },
      { ...base, http: { timeoutMs: "10s", retries: 1 } },
      { ...base, sources: [{ ...base.sources[0], recentRuns: undefined }] },
      { ...base, sources: [{ ...base.sources[0], id: "collect-cctv" }] },
      {
        ...base,
        sources: [
          {
            ...base.sources[0],
            recentRuns: [
              { startedAt: "x", finishedAt: "y", status: "ok", failures: [] },
            ],
          },
        ],
      },
      {
        ...base,
        sources: [
          {
            ...base.sources[0],
            recentRuns: [
              { ...base.sources[0]!.recentRuns![0]!, startedAt: "x" },
            ],
          },
        ],
      },
      { ...base, generatedAt: "어제" },
      { ...base, sources: [base.sources[0], base.sources[0]] },
      { ...base, keys: [{ ...base.keys[0], status: "expired" }] },
      {
        ...base,
        sources: [
          {
            ...base.sources[0],
            schedule: { periodMinutes: 0, offsetMinutes: 3, offSeason: null },
          },
        ],
      },
    ];
    for (const body of broken) expect(validSources(body)).toBe(false);
  });

  it("최근 실행 null(읽지 못함)은 모양으로는 통과", () => {
    const base = view();
    expect(
      validSources({
        ...base,
        sources: [{ ...base.sources[0], recentRuns: null }],
      }),
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
