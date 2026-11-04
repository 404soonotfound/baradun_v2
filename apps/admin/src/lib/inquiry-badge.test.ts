import { describe, expect, it } from "vitest";
import {
  adjustReceivedCount,
  badgeOwner,
  receivedCountKnown,
  setReceivedCount,
} from "./inquiry-badge";

// 메뉴 문의 배지 (BRD-153). 값은 읽은 계정에 묶임

describe("문의 배지", () => {
  it("다른 계정(로그아웃 뒤 데모 등)에는 앞 계정 값을 쓰지 않는다", () => {
    setReceivedCount("operator:a@example.test", 3);
    expect(receivedCountKnown("operator:a@example.test")).toBe(true);
    expect(receivedCountKnown("demo:demo@example.test")).toBe(false);
    // 주인이 아닌 계정의 조정은 무시
    adjustReceivedCount("demo:demo@example.test", -1);
    setReceivedCount("demo:demo@example.test", 1);
    expect(receivedCountKnown("operator:a@example.test")).toBe(false);
  });

  it("주인은 풀과 이메일, 로그아웃이면 없음", () => {
    expect(badgeOwner({ status: "signed_out" })).toBeNull();
    expect(
      badgeOwner({
        status: "signed_in",
        pool: "demo",
        email: "d@example.test",
      }),
    ).toBe("demo:d@example.test");
  });
});
