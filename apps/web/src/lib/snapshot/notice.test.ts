import type { Notice } from "@baradun/contracts";
import { describe, expect, it } from "vitest";

import { DEVICE_CLOCK, type Clock } from "./clock";
import { activeNotice, noticeDeadlines, readNotices } from "./notice";

// 운영자 공지 (BRD-151 · D15-6·D16-D4, 구현 제안 I09)

const TRUSTED: Clock = { offsetMs: 0, trusted: true };
const at = (iso: string) => Date.parse(iso);

function notice(overrides: Partial<Notice> = {}): Notice {
  return {
    id: "n-general",
    kind: "general",
    title: { ko: "새 해변을 더했어요", en: "New beaches added" },
    body: {
      ko: "동해안 해변 3곳을 더했어요.",
      en: "We added 3 beaches on the east coast.",
    },
    startsAt: "2026-10-17T00:00:00Z",
    endsAt: "2026-10-17T18:00:00Z",
    ...overrides,
  };
}

describe("readNotices", () => {
  it("칸이 없거나 배열이 아니면 공지 없음", () => {
    expect(readNotices(undefined)).toEqual([]);
    expect(readNotices(null)).toEqual([]);
    expect(readNotices({ 0: notice() })).toEqual([]);
  });

  it("깨진 공지만 빼고 나머지는 씀", () => {
    const good = notice();
    const open = notice({ id: "n-open", endsAt: null });
    const broken = [
      { ...notice(), kind: "urgent" }, // 모르는 종류
      { ...notice(), title: { ko: "제목만" } }, // 영어 문구 없음
      { ...notice(), body: { ko: "", en: "x" } }, // 빈 문구
      { ...notice(), startsAt: "2026-10-17T09:00:00+09:00" }, // UTC 아님
      { ...notice(), endsAt: "2026-10-17T18:00:00" }, // 시간대 없음
      { ...notice(), endsAt: undefined }, // 끝 칸 없음(null이어야 함)
      { ...notice(), startsAt: "2026-02-30T00:00:00Z" }, // 없는 날짜
      { ...notice(), id: "N 1" }, // ID 형식
      { ...notice(), category: "unavailable" }, // 판단 상태를 실으려는 칸
      "공지",
      null,
    ];
    expect(readNotices([good, ...broken, open])).toEqual([good, open]);
  });
});

describe("activeNotice", () => {
  const notices = [notice()];

  it("시작 포함·끝 제외", () => {
    expect(
      activeNotice(notices, at("2026-10-16T23:59:59.999Z"), TRUSTED),
    ).toBeNull();
    expect(activeNotice(notices, at("2026-10-17T00:00:00Z"), TRUSTED)).toEqual(
      notices[0],
    );
    expect(
      activeNotice(notices, at("2026-10-17T17:59:59.999Z"), TRUSTED),
    ).toEqual(notices[0]);
    expect(
      activeNotice(notices, at("2026-10-17T18:00:00Z"), TRUSTED),
    ).toBeNull();
  });

  it("끝을 정하지 않은 공지(endsAt null)는 시작 뒤 계속 보임", () => {
    const open = [notice({ endsAt: null })];
    expect(activeNotice(open, at("2030-01-01T00:00:00Z"), TRUSTED)).toEqual(
      open[0],
    );
  });

  it("서버 시각을 모르거나 지금 시각을 모르면 보이지 않음(I09)", () => {
    const now = at("2026-10-17T05:00:00Z");
    expect(activeNotice(notices, now, DEVICE_CLOCK)).toBeNull();
    expect(activeNotice(notices, NaN, TRUSTED)).toBeNull();
  });

  it("공지가 없으면 null", () => {
    const now = at("2026-10-17T05:00:00Z");
    expect(activeNotice(undefined, now, TRUSTED)).toBeNull();
    expect(activeNotice([], now, TRUSTED)).toBeNull();
  });

  it("점검 예고 > 일반, 같은 종류는 시작이 늦은 것, 같으면 id 오름차순", () => {
    const now = at("2026-10-17T05:00:00Z");
    const general = notice({
      id: "a-general",
      startsAt: "2026-10-17T04:00:00Z",
    });
    const oldMaint = notice({
      id: "m-old",
      kind: "maintenance_notice",
      startsAt: "2026-10-17T01:00:00Z",
    });
    const newMaintB = notice({
      id: "m-new-b",
      kind: "maintenance_notice",
      startsAt: "2026-10-17T02:00:00Z",
    });
    const newMaintA = notice({
      id: "m-new-a",
      kind: "maintenance_notice",
      startsAt: "2026-10-17T02:00:00Z",
    });
    expect(
      activeNotice([general, oldMaint, newMaintB, newMaintA], now, TRUSTED)?.id,
    ).toBe("m-new-a");
    expect(activeNotice([general, oldMaint], now, TRUSTED)?.id).toBe("m-old");
    // 끝난 점검 예고는 고르지 않음
    const endedMaint = notice({
      id: "m-ended",
      kind: "maintenance_notice",
      endsAt: "2026-10-17T03:00:00Z",
    });
    expect(activeNotice([endedMaint, general], now, TRUSTED)?.id).toBe(
      "a-general",
    );
  });

  it("넘긴 목록 순서를 바꾸지 않음", () => {
    const list = [
      notice({ id: "b" }),
      notice({ id: "a", kind: "maintenance_notice" }),
    ];
    activeNotice(list, at("2026-10-17T05:00:00Z"), TRUSTED);
    expect(list.map((item) => item.id)).toEqual(["b", "a"]);
  });
});

describe("noticeDeadlines", () => {
  it("시작·끝 시각(끝이 없으면 시작만)", () => {
    expect(
      noticeDeadlines([notice(), notice({ id: "n-open", endsAt: null })]),
    ).toEqual([
      at("2026-10-17T00:00:00Z"),
      at("2026-10-17T18:00:00Z"),
      at("2026-10-17T00:00:00Z"),
    ]);
    expect(noticeDeadlines(undefined)).toEqual([]);
  });
});
