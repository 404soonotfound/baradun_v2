import { describe, expect, it } from "vitest";
import type { PublishedView } from "./beaches";
import type { CollectionView, JobCollection } from "./collection";
import {
  beachCounts,
  collectionSummary,
  expiredCount,
  inquirySummary,
  ratioPercent,
  reasonTime,
  undeterminedRows,
  judgmentLine,
  mergePart,
  noticeCounts,
  PART_TIMEOUT_MS,
  staleSince,
  partOf,
  settle,
  todos,
} from "./home";
import type { NoticeView } from "./notices";

// 운영 홈 요약 계산 (BRD-149, ADM-HOME)

const job = (
  name: string,
  status: "complete" | "partial" | "failed" | null,
  overdue: boolean | null = false,
): JobCollection =>
  ({
    job: name,
    lastRun: status
      ? { startedAt: "2026-11-12T00:00:00Z", status, failures: [] }
      : null,
    lastSuccessAt: null,
    day: { complete: 0, partial: 0, failed: 0 },
    week: { complete: 0, partial: 0, failed: 0 },
    hourly: [],
    incidents: [],
    truncated: false,
    lateAfterMinutes: 45,
    overdue,
  }) as unknown as JobCollection;

const collection = (jobs: JobCollection[]): CollectionView =>
  ({
    generatedAt: "2026-11-12T00:00:00Z",
    publishedVersion: null,
    jobs,
    publish: null,
    alarms: { status: "unavailable" },
    stations: { status: "unavailable" },
  }) as unknown as CollectionView;

describe("판단 출처 상태 한 줄", () => {
  it("특보·해양 관측 둘 다 정상이면 문제 없음. 참고 출처 실패는 보지 않음", () => {
    const line = judgmentLine(
      collection([
        job("collect-warnings", "complete"),
        job("collect-ocean", "complete"),
        job("collect-rip", "failed"),
      ]),
    );
    expect(line?.sources.map((s) => s.job)).toEqual([
      "collect-warnings",
      "collect-ocean",
    ]);
    expect(line?.problems).toEqual([]);
  });

  it("실패·지연·지연 확인 못 함·응답에 빠진 출처는 모두 문제로 본다(정상으로 바꾸지 않음)", () => {
    expect(
      judgmentLine(
        collection([
          job("collect-warnings", "failed"),
          job("collect-ocean", "complete", true),
        ]),
      )?.problems,
    ).toEqual([
      { job: "collect-warnings", state: "failed" },
      { job: "collect-ocean", state: "late" },
    ]);
    expect(
      judgmentLine(collection([job("collect-warnings", "complete", null)]))
        ?.problems,
    ).toEqual([
      { job: "collect-warnings", state: "unchecked" },
      { job: "collect-ocean", state: "none" },
    ]);
  });

  it("수집 현황을 불러오지 못하면 null('확인 못 함')", () => {
    expect(judgmentLine(null)).toBeNull();
  });
});

describe("요약 값", () => {
  it("유효 시각이 지난 해변 수는 분류와 따로 센다(시각을 못 읽으면 지난 것). 게시본을 못 읽으면 null", () => {
    const now = Date.parse("2026-11-12T01:00:00Z");
    const view: PublishedView = {
      available: true,
      snapshotVersion: "20261112T000000Z",
      generatedAt: "2026-11-12T00:00:00Z",
      maintenance: { active: false, until: null },
      beaches: {
        b0001: {
          category: "clear",
          reasons: [],
          validUntil: "2026-11-12T01:00:00Z",
        },
        b0002: {
          category: "clear",
          reasons: [],
          validUntil: "2026-11-12T00:59:59Z",
        },
        b0003: { category: "undetermined", reasons: [], validUntil: "?" },
      },
    };
    expect(expiredCount(view, now)).toBe(2);
    expect(
      expiredCount({ available: false, reason: "read_failed" }, now),
    ).toBeNull();
  });

  it("공지는 예약·수정 대기를 따로 센다", () => {
    const notice = (state: string, pendingEdit = false) =>
      ({ state, pendingEdit }) as NoticeView;
    expect(
      noticeCounts([
        notice("scheduled"),
        notice("live", true),
        notice("live"),
        notice("draft"),
      ]),
    ).toEqual({ scheduled: 1, pendingEdit: 1 });
    expect(noticeCounts(null)).toBeNull();
  });
});

describe("할 일", () => {
  const ok = { sources: [], problems: [] };

  it("처리할 것이 있을 때만 줄이 생긴다", () => {
    expect(
      todos({
        judgment: {
          sources: [],
          problems: [{ job: "collect-ocean", state: "failed" }],
        },
        received: 2,
        notices: { scheduled: 1, pendingEdit: 1 },
      }),
    ).toEqual({
      items: [
        { key: "sources", count: 1, href: "/collection/" },
        { key: "inquiries", count: 2, href: "/inquiries/" },
        { key: "notices", count: 1, href: "/publish/" },
      ],
      incomplete: false,
    });
    expect(
      todos({
        judgment: ok,
        received: 0,
        notices: { scheduled: 2, pendingEdit: 0 },
      }),
    ).toEqual({ items: [], incomplete: false });
  });

  it("하나라도 불러오지 못하면 incomplete — '할 일 없음'으로 보이지 않게 함", () => {
    for (const input of [
      {
        judgment: null,
        received: 0,
        notices: { scheduled: 0, pendingEdit: 0 },
      },
      {
        judgment: ok,
        received: null,
        notices: { scheduled: 0, pendingEdit: 0 },
      },
      { judgment: ok, received: 0, notices: null },
    ]) {
      expect(todos(input)).toEqual({ items: [], incomplete: true });
    }
  });
});

describe("응답 하나의 결과", () => {
  it("성공 / 403은 권한 없음 / 그 밖의 실패와 본문 모양 틀림은 불러오지 못함", () => {
    expect(
      partOf({ ok: true, status: 200, body: { n: 1 } }, (b) => b.n),
    ).toEqual({ state: "ok", value: 1 });
    expect(
      partOf(
        { ok: false, status: 403, code: "forbidden", requestId: "req-1" },
        () => 1,
      ),
    ).toEqual({ state: "forbidden" });
    expect(
      partOf(
        {
          ok: false,
          status: 403,
          code: "sample_not_allowed",
          requestId: "req-3",
        },
        () => 1,
      ),
    ).toEqual({ state: "failed", requestId: "req-3" });
    expect(
      partOf(
        { ok: false, status: 500, code: "internal", requestId: "req-7f3a2c91" },
        () => 1,
      ),
    ).toEqual({ state: "failed", requestId: "req-7f3a2c91" });
    expect(partOf({ ok: false, status: 0, code: "network" }, () => 1)).toEqual({
      state: "failed",
      requestId: null,
    });
    expect(partOf({ ok: true, status: 200, body: {} }, () => null)).toEqual({
      state: "failed",
      requestId: null,
    });
  });
});

describe("시간 제한", () => {
  it("응답이 시간 안에 오지 않거나 예외가 나면 불러오지 못함(불러오는 중에 머물지 않음)", async () => {
    await expect(settle(() => new Promise(() => {}), 10)).resolves.toEqual({
      state: "failed",
      requestId: null,
    });
    await expect(
      settle(() => Promise.reject(new Error("x")), 10),
    ).resolves.toEqual({ state: "failed", requestId: null });
    await expect(
      settle(() => Promise.resolve({ state: "ok", value: 1 }), 10),
    ).resolves.toEqual({ state: "ok", value: 1 });
  });
});

describe("mergePart (다시 읽기 값 유지, GH-462)", () => {
  const ok = { state: "ok", value: 3 } as const;
  const failed = { state: "failed", requestId: "r1" } as const;

  it("다시 읽기가 실패해도 앞에서 받은 값을 두고 stale로 알림", () => {
    expect(mergePart(ok, failed)).toEqual({ part: ok, stale: true });
  });

  it("새 값이 오면 바꾸고 stale을 끔", () => {
    expect(mergePart(ok, { state: "ok", value: 5 })).toEqual({
      part: { state: "ok", value: 5 },
      stale: false,
    });
  });

  it("앞 값이 없으면(첫 읽기·이미 실패) 실패를 그대로 보임", () => {
    expect(mergePart({ state: "loading" }, failed)).toEqual({
      part: failed,
      stale: false,
    });
    expect(mergePart(failed, failed)).toEqual({ part: failed, stale: false });
  });

  it("keep=false(판단 출처)면 앞의 정상 값을 두지 않고 실패를 그대로 보임", () => {
    expect(mergePart(ok, failed, false)).toEqual({
      part: failed,
      stale: false,
    });
  });

  it("권한 없음은 앞 값을 두지 않고 그대로 보임", () => {
    expect(mergePart(ok, { state: "forbidden" })).toEqual({
      part: { state: "forbidden" },
      stale: false,
    });
  });
});

describe("PART_TIMEOUT_MS", () => {
  it("칸 시간 제한은 15초(D26-4)", () => {
    expect(PART_TIMEOUT_MS).toBe(15_000);
  });
});

describe("staleSince (앞 값을 둔 칸의 받은 시각)", () => {
  it("가장 오래 받은 시각을 고르고, 기준 시각과 같은 날(서울)인지 알려 줌", () => {
    expect(
      staleSince(
        ["2026-11-14T05:10:00Z", undefined, "2026-11-14T04:00:00Z"],
        "2026-11-14T06:00:00Z",
      ),
    ).toEqual({ iso: "2026-11-14T04:00:00Z", sameDay: true });
  });

  it("서울 날짜가 다르면 sameDay=false(자정 넘김)", () => {
    // 11/13 23:50 KST → 11/14 00:10 KST
    expect(
      staleSince(["2026-11-13T14:50:00Z"], "2026-11-13T15:10:00Z"),
    ).toEqual({ iso: "2026-11-13T14:50:00Z", sameDay: false });
  });

  it("받은 시각이 없으면 null", () => {
    expect(staleSince([undefined], "2026-11-14T06:00:00Z")).toBeNull();
  });
});

// ---- 시안 V1 세 칸·판단불가 표 (GH-453) ----

const published = (
  beaches: Record<string, { category: string; reasons?: object[] }>,
): PublishedView =>
  ({
    available: true,
    snapshotVersion: "20261111T030000Z",
    generatedAt: "2026-11-11T03:00:12Z",
    maintenance: { active: false, until: null },
    beaches: Object.fromEntries(
      Object.entries(beaches).map(([id, b]) => [
        id,
        { reasons: [], validUntil: "2026-11-11T04:00:00Z", ...b },
      ]),
    ),
  }) as unknown as PublishedView;

describe("앱에 보이는 해변 칸 (beachCounts)", () => {
  it("게시본 분류 그대로 셈", () => {
    expect(
      beachCounts(
        published({
          b1: { category: "clear" },
          b2: { category: "unavailable" },
          b3: { category: "undetermined" },
          b4: { category: "clear" },
        }),
      ),
    ).toEqual({ total: 4, clear: 2, unavailable: 1, undetermined: 1 });
  });

  it("게시본을 못 읽었거나 게시본이 없다는 응답이면 0곳이 아니라 null", () => {
    expect(beachCounts(null)).toBeNull();
    expect(beachCounts({ available: false, reason: "missing" })).toBeNull();
  });
});

describe("판단불가 해변 표 (undeterminedRows)", () => {
  const names = {
    b0002: { name: "경포해변", region: "강원 강릉시" },
    b0003: { name: "망상해수욕장", region: "강원 동해시" },
  };

  it("판단불가만, ID 순으로, 첫 사유와 이름표 이름", () => {
    const rows = undeterminedRows(
      published({
        b0003: {
          category: "undetermined",
          reasons: [
            {
              code: "observation_delayed",
              scope: "삼척 파고부이",
              source: "기상청",
              at: "2026-11-11T01:00:00Z",
            },
          ],
        },
        b0001: { category: "clear" },
        b0002: {
          category: "undetermined",
          reasons: [
            {
              code: "warning_unknown",
              scope: "강원중부앞바다",
              source: "기상청",
              at: null,
            },
            {
              code: "observation_delayed",
              scope: "x",
              source: "기상청",
              at: null,
            },
          ],
        },
      }),
      names,
    );
    expect(rows?.map((r) => r.id)).toEqual(["b0002", "b0003"]);
    expect(rows?.[0]).toMatchObject({
      name: "경포해변",
      region: "강원 강릉시",
      reason: { scope: "강원중부앞바다" },
    });
    // 사유가 둘 이상이면 배지도 전부(첫 사유만 남기고 숨기지 않음)
    expect(rows?.[0]?.labels.map((l) => l.kind)).toEqual([
      "warning_unknown",
      "observation_delayed",
    ]);
    expect(rows?.[1]?.labels[0]).toEqual({ kind: "observation_delayed" });
  });

  it("이름표에 없는 해변은 이름 null(ID를 이름으로 쓰지 않음), 사유가 없으면 '특보 확인 못 함' 계열", () => {
    const rows = undeterminedRows(
      published({ b9999: { category: "undetermined" } }),
      names,
    );
    expect(rows).toEqual([
      {
        id: "b9999",
        name: null,
        region: null,
        labels: [{ kind: "unconfirmed" }],
        reason: null,
      },
    ]);
  });

  it("객체 기본 속성 이름과 같은 ID도 이름표에 없으면 이름 null", () => {
    const rows = undeterminedRows(
      published({ constructor: { category: "undetermined" } }),
      names,
    );
    expect(rows?.[0]).toMatchObject({ id: "constructor", name: null, region: null });
  });

  it("게시본을 못 읽으면 빈 표가 아니라 null", () => {
    expect(undeterminedRows(null, names)).toBeNull();
    expect(
      undeterminedRows({ available: false, reason: "missing" }, names),
    ).toBeNull();
  });
});

describe("사유 시각 (reasonTime)", () => {
  it("특보 확인 못 함은 마지막 확인, 관측 지연은 측정 시각", () => {
    expect(
      reasonTime({ code: "warning_unknown", at: "2026-11-11T05:30:00Z" }),
    ).toEqual({ kind: "confirmed", at: "2026-11-11T05:30:00Z" });
    expect(
      reasonTime({ code: "observation_delayed", at: "2026-11-11T03:38:00Z" }),
    ).toEqual({ kind: "observed", at: "2026-11-11T03:38:00Z" });
  });

  it("시각이 없거나 틀리거나 사유가 없으면 null(지금 시각으로 채우지 않음)", () => {
    expect(reasonTime({ code: "warning_unknown", at: null })).toBeNull();
    expect(reasonTime({ code: "observation_delayed", at: "어제" })).toBeNull();
    expect(reasonTime(null)).toBeNull();
    expect(
      reasonTime({ code: "warning", at: "2026-11-11T03:38:00Z" }),
    ).toBeNull();
  });
});

const runJob = (
  name: string,
  runs: number,
  ok: number,
  status: "complete" | "failed" = "complete",
): JobCollection =>
  ({
    job: name,
    lastRun: {
      startedAt: "2026-11-12T00:00:00Z",
      finishedAt: "2026-11-12T00:01:00Z",
      status,
      failures: [],
    },
    lastSuccessAt: "2026-11-12T00:01:00Z",
    day: { runs, ok },
    week: { runs, ok },
    hourly: [],
    incidents: [],
    truncated: false,
    lateAfterMinutes: 45,
    overdue: false,
  }) as unknown as JobCollection;

describe("수집 칸 (collectionSummary)", () => {
  it("보이는 줄은 특보·해양 관측·이안류, 전체 성공률·문제 수는 모든 출처 기준", () => {
    const summary = collectionSummary(
      collection([
        runJob("collect-warnings", 100, 99),
        runJob("collect-ocean", 100, 100),
        runJob("collect-rip", 50, 50),
        runJob("collect-weather", 50, 45, "failed"),
        runJob("collect-catalog", 0, 0),
      ]),
    );
    expect(summary?.rows.map((r) => r.job)).toEqual([
      "collect-warnings",
      "collect-ocean",
      "collect-rip",
    ]);
    expect(summary?.rows[0]).toMatchObject({ state: "ok", rate: 99 });
    // 294 / 300
    expect(summary?.rate).toBe(98);
    // 날씨 예보 실패는 줄에 없어도 문제 수에 듦
    expect(summary?.problems).toBe(1);
  });

  it("응답에 없는 출처는 '기록 없음'·성공률 null(정상·0%가 아님)", () => {
    const summary = collectionSummary(
      collection([runJob("collect-warnings", 10, 10)]),
    );
    expect(summary?.rows[1]).toEqual({
      job: "collect-ocean",
      state: "none",
      rate: null,
      lastSuccessAt: null,
    });
    expect(summary?.problems).toBe(4);
    // 남은 출처(특보 10/10)만으로 100%라 하지 않음
    expect(summary?.rate).toBeNull();
  });

  it("실행이 없으면 전체 성공률 null, 수집 현황을 못 읽으면 null", () => {
    expect(
      collectionSummary(collection([runJob("collect-warnings", 0, 0)]))?.rate,
    ).toBeNull();
    expect(collectionSummary(null)).toBeNull();
  });
});

describe("문의 칸 (inquirySummary)", () => {
  it("처리 상태별 수와 합", () => {
    expect(
      inquirySummary({
        items: [],
        nextCursor: null,
        counts: { received: 3, in_progress: 2, resolved: 6, rejected: 1 },
      }),
    ).toEqual({
      total: 12,
      received: 3,
      inProgress: 2,
      resolved: 6,
      rejected: 1,
    });
  });

  it("상태별 수가 없거나 하나라도 숫자가 아니면 0건이 아니라 null", () => {
    expect(inquirySummary(null)).toBeNull();
    expect(inquirySummary({ items: [], nextCursor: null })).toBeNull();
    expect(
      inquirySummary({
        items: [],
        nextCursor: null,
        counts: {
          received: 3,
          in_progress: Number.NaN,
          resolved: 1,
          rejected: 0,
        },
      }),
    ).toBeNull();
  });
});

describe("막대 길이 (ratioPercent)", () => {
  it("전체 대비 %(소수 첫째 자리), 전체 0이면 0, 넘치면 100", () => {
    expect(ratioPercent(3, 11)).toBe(27.3);
    expect(ratioPercent(0, 0)).toBe(0);
    expect(ratioPercent(5, 4)).toBe(100);
  });
});
