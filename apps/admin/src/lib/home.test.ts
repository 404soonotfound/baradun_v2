import { describe, expect, it } from "vitest";
import type { PublishedView } from "./beaches";
import type { CollectionView, JobCollection } from "./collection";
import type { AuditView } from "./audit";
import {
  expiredCount,
  judgmentLine,
  noticeCounts,
  partOf,
  receivedCount,
  recentChanges,
  settle,
  todos,
  undeterminedCount,
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
  it("판단불가 해변 수는 게시본의 undetermined만 센다. 게시본을 못 읽으면 null", () => {
    const view: PublishedView = {
      available: true,
      snapshotVersion: "20261112T000000Z",
      generatedAt: "2026-11-12T00:00:00Z",
      maintenance: { active: false, until: null },
      beaches: {
        b0001: { category: "clear", reasons: [], validUntil: "" },
        b0002: { category: "undetermined", reasons: [], validUntil: "" },
        b0003: { category: "unavailable", reasons: [], validUntil: "" },
        b0004: { category: "undetermined", reasons: [], validUntil: "" },
      },
    };
    expect(undeterminedCount(view)).toBe(2);
    expect(
      undeterminedCount({ available: false, reason: "read_failed" }),
    ).toBeNull();
    expect(undeterminedCount(null)).toBeNull();
  });

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

  it("새 문의 수는 첫 쪽 상태별 수의 접수. 수가 없으면 null(0이 아님)", () => {
    expect(
      receivedCount({
        items: [],
        nextCursor: null,
        counts: { received: 3, in_progress: 1, resolved: 0, rejected: 0 },
      }),
    ).toBe(3);
    expect(receivedCount({ items: [], nextCursor: null })).toBeNull();
    expect(receivedCount(null)).toBeNull();
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
        { key: "notices", count: 1, href: "/notices/" },
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

describe("최근 변경·시간 제한", () => {
  const audit = (action: string, n: number) =>
    ({ action, requestId: `req-${n}` }) as AuditView;

  it("데모 계정의 조회·거절 기록은 빼고 운영자 변경만 앞에서 몇 건", () => {
    const items = [
      audit("sample.read", 1),
      audit("notice.create", 2),
      audit("sample.denied", 3),
      audit("inquiry.update", 4),
      audit("beach.memo", 5),
    ];
    expect(recentChanges(items, 2)).toEqual({
      items: [items[1], items[3]],
      onlyReads: false,
    });
    expect(recentChanges([audit("sample.read", 1)], 5)).toEqual({
      items: [],
      onlyReads: true,
    });
    expect(recentChanges([], 5)).toEqual({ items: [], onlyReads: false });
  });

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
