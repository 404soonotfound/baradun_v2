import { describe, expect, it, vi } from "vitest";

import { addToFront, createDeviceList, parseIds } from "./device-list";

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

describe("createDeviceList", () => {
  it("읽기는 되고 쓰기만 막힌 저장소에서도 이번 방문 동안 바뀐 값을 유지한다", () => {
    // 사생활 보호 모드처럼 getItem은 옛 값을 주고 setItem은 오류
    vi.stubGlobal("localStorage", {
      getItem: () => '["b0001"]',
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
    });
    try {
      const list = createDeviceList("test:list", 10);
      list.add("b0002");
      expect(list.getSnapshot()).toEqual(["b0002", "b0001"]);
      list.remove("b0001");
      expect(list.getSnapshot()).toEqual(["b0002"]);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
