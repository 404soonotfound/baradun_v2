import { describe, expect, it } from "vitest";
import { decideStateWrite, sameStateValue } from "./rules";

// 저장 규칙 순수 함수 검사 (BRD-55)

const current = {
  pk: "p",
  sk: "s",
  value: { a: 1, b: [1, { c: null }] },
  orderAt: 100,
  recordVersion: 4,
};

describe("decideStateWrite", () => {
  it("기록이 없으면 recordVersion 1로 쓰고, 기대 버전은 없음(null)", () => {
    expect(decideStateWrite(null, "p", "s", 1, 100)).toEqual({
      kind: "write",
      record: { pk: "p", sk: "s", value: 1, orderAt: 100, recordVersion: 1 },
      expectedVersion: null,
    });
  });

  it("오래된 orderAt → stale, 같은 orderAt·같은 값 → unchanged", () => {
    expect(decideStateWrite(current, "p", "s", current.value, 99).kind).toBe(
      "stale",
    );
    expect(
      decideStateWrite(current, "p", "s", { b: [1, { c: null }], a: 1 }, 100)
        .kind,
    ).toBe("unchanged");
  });

  it("부르는 쪽이 준 기대 버전이 지금 값과 다르면 conflict", () => {
    expect(decideStateWrite(current, "p", "s", { a: 2 }, 100, 3).kind).toBe(
      "conflict",
    );
    expect(decideStateWrite(null, "p", "s", 1, 100, 4).kind).toBe("conflict");
    expect(decideStateWrite(current, "p", "s", { a: 2 }, 100, 4).kind).toBe(
      "write",
    );
    expect(decideStateWrite(null, "p", "s", 1, 100, null).kind).toBe("write");
  });

  it("쓸 때는 읽은 recordVersion을 기대 버전으로, 새 버전은 +1", () => {
    const decision = decideStateWrite(current, "p", "s", { a: 2 }, 100);
    expect(decision).toMatchObject({
      kind: "write",
      record: { recordVersion: 5 },
      expectedVersion: 4,
    });
  });
});

describe("sameStateValue", () => {
  it("배열 순서·타입 차이는 다른 값", () => {
    expect(sameStateValue([1, 2], [2, 1])).toBe(false);
    expect(sameStateValue("1", 1)).toBe(false);
    expect(sameStateValue(null, {})).toBe(false);
  });
});
