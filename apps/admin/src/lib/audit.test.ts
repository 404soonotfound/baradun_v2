import { describe, expect, it } from "vitest";
import { kstDay, periodFilter, shortSub } from "./audit";

describe("변경 이력 거르기 값", () => {
  it("기간은 지금부터 거꾸로 UTC로 만들고, 고른 종류·운영자만 넣는다", () => {
    const now = Date.parse("2026-11-04T03:00:00Z");
    expect(periodFilter(7, now, null, null)).toEqual({
      from: "2026-10-28T03:00:00.000Z",
      to: "2026-11-04T03:00:00.000Z",
    });
    expect(periodFilter(30, now, "notice.end", "sub-1")).toMatchObject({
      action: "notice.end",
      actor: "sub-1",
    });
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
