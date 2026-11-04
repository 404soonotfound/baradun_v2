import { describe, expect, it } from "vitest";
import { diffLines, kstDay, periodFilter, shortSub } from "./audit";

describe("변경 이력 거르기 값", () => {
  it("기간은 지금부터 거꾸로 UTC로 만들고, 고른 종류·운영자만 넣는다", () => {
    const now = Date.parse("2026-11-04T03:00:00Z");
    expect(periodFilter(7, now)).toEqual({
      from: "2026-10-28T03:00:00.000Z",
      to: "2026-11-04T03:00:00.000Z",
    });
    expect(
      periodFilter(30, now, {
        category: "notice",
        actor: "sub-1",
        q: " 점검 ",
      }),
    ).toMatchObject({ category: "notice", actor: "sub-1", q: "점검" });
    expect(periodFilter(30, now, { q: "  " })).not.toHaveProperty("q");
  });

  it("날짜 묶음은 KST 기준(UTC 15시는 다음 날)", () => {
    expect(kstDay("2026-11-03T15:00:00Z")).toBe("11/4");
    expect(kstDay("2026-11-03T14:59:00Z")).toBe("11/3");
  });

  it("운영자 sub는 앞 8자로 줄인다", () => {
    expect(shortSub("aaaaaaaa-1111-4222")).toBe("aaaaaaaa…");
    expect(shortSub("short")).toBe("short");
  });
});

describe("공지 문구 바뀐 줄", () => {
  it("같은 자리 줄끼리 비교해 뺀 줄 다음에 더한 줄을 두고 줄 번호를 따로 센다", () => {
    expect(
      diffLines(
        ["kind: 점검", "title.en: (없음)", "period: x"],
        ["kind: 점검", "title.en: Maintenance", "period: x"],
      ),
    ).toEqual([
      { kind: "same", oldNo: 1, newNo: 1, text: "kind: 점검" },
      { kind: "del", oldNo: 2, newNo: null, text: "title.en: (없음)" },
      { kind: "add", oldNo: null, newNo: 2, text: "title.en: Maintenance" },
      { kind: "same", oldNo: 3, newNo: 3, text: "period: x" },
    ]);
  });

  it("만들기(앞 없음)는 모두 더한 줄, 지우기(뒤 없음)는 모두 뺀 줄", () => {
    expect(diffLines([], ["a", "b"]).map((l) => l.kind)).toEqual([
      "add",
      "add",
    ]);
    expect(diffLines(["a"], []).map((l) => l.kind)).toEqual(["del"]);
  });
});
