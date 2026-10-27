import { describe, expect, it } from "vitest";

import {
  addRecent,
  parseRecent,
  RECENT_MAX,
  visibleRecent,
} from "@/lib/recent-search";

describe("addRecent", () => {
  it("맨 앞에 넣고 같은 검색어(공백·대소문자 무시)는 하나로", () => {
    const list = addRecent(
      [
        { q: "경포", id: null },
        { q: "Gangmun", id: "b1" },
      ],
      { q: " gang mun ", id: "b1" },
    );
    expect(list.map((item) => item.q)).toEqual(["gang mun", "경포"]);
  });

  it("최대 10개, 넘으면 오래된 것부터 버림", () => {
    let list: ReturnType<typeof addRecent> = [];
    for (let i = 0; i < 12; i++)
      list = addRecent(list, { q: `검색${i}`, id: null });
    expect(list).toHaveLength(RECENT_MAX);
    expect(list[0]?.q).toBe("검색11");
    expect(list.at(-1)?.q).toBe("검색2");
  });

  it("빈 검색어는 넣지 않음, 너무 긴 검색어는 잘라 둠", () => {
    expect(addRecent([], { q: "  ", id: null })).toEqual([]);
    expect(addRecent([], { q: "가".repeat(80), id: null })[0]?.q).toHaveLength(
      50,
    );
  });
});

describe("parseRecent", () => {
  it("깨진 저장 값은 빈 목록, 모양이 다른 항목은 건너뜀", () => {
    expect(parseRecent(null)).toEqual([]);
    expect(parseRecent("{ 깨짐")).toEqual([]);
    expect(parseRecent('{"q":"a"}')).toEqual([]);
    expect(
      parseRecent(
        JSON.stringify([
          { q: "경포", id: "b1" },
          3,
          { q: 1 },
          { q: "" },
          { q: "강문" },
        ]),
      ),
    ).toEqual([
      { q: "경포", id: "b1" },
      { q: "강문", id: null },
    ]);
  });

  it("저장 값이 10개를 넘어도 10개만", () => {
    const many = Array.from({ length: 15 }, (_, i) => ({
      q: `q${i}`,
      id: null,
    }));
    expect(parseRecent(JSON.stringify(many))).toHaveLength(RECENT_MAX);
  });
});

describe("visibleRecent", () => {
  it("노출을 끈 해변(보이는 id에 없음)의 항목은 뺌, 해변 없는 검색어는 남김", () => {
    const list = [
      { q: "숨김해변", id: "hidden-1" },
      { q: "경포", id: "b1" },
      { q: "강릉", id: null },
    ];
    expect(visibleRecent(list, new Set(["b1"])).map((item) => item.q)).toEqual([
      "경포",
      "강릉",
    ]);
  });
});
