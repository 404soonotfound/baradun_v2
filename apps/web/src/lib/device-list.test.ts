import { describe, expect, it } from "vitest";

import { addToFront, parseIds } from "./device-list";

// 기기 저장 id 목록 규칙 (BRD-26)

describe("addToFront", () => {
  it("새 id를 맨 앞에 넣는다", () => {
    expect(addToFront(["b0002"], "b0001", 10)).toEqual(["b0001", "b0002"]);
  });

  it("이미 있으면 맨 앞으로 옮기고 중복을 만들지 않는다", () => {
    expect(addToFront(["b0001", "b0002", "b0003"], "b0003", 10)).toEqual([
      "b0003",
      "b0001",
      "b0002",
    ]);
  });

  it("max를 넘으면 가장 오래된 것부터 버린다", () => {
    expect(addToFront(["b0001", "b0002"], "b0003", 2)).toEqual([
      "b0003",
      "b0001",
    ]);
  });

  it("받은 배열을 고치지 않는다", () => {
    const list = ["b0001"];
    addToFront(list, "b0002", 10);
    expect(list).toEqual(["b0001"]);
  });
});

describe("parseIds", () => {
  it("저장된 값이 없으면 빈 목록", () => {
    expect(parseIds(null)).toEqual([]);
  });

  it("JSON이 깨졌거나 배열이 아니면 빈 목록", () => {
    expect(parseIds("[b0001")).toEqual([]);
    expect(parseIds('{"id":"b0001"}')).toEqual([]);
  });

  it("글자가 아닌 항목은 버린다", () => {
    expect(parseIds('["b0001", 3, null]')).toEqual(["b0001"]);
  });
});
