import { describe, expect, it } from "vitest";
import { copula, topicParticle } from "./korean";

describe("조사·어미", () => {
  it("주제 조사: 받침 있으면 '은', 없으면 '는'", () => {
    expect(topicParticle("들어온 경로")).toBe("는");
    expect(topicParticle("많이 본 화면")).toBe("은");
    expect(topicParticle("앞 기간 비교")).toBe("는");
    expect(topicParticle("abc")).toBe("는");
    expect(topicParticle("")).toBe("는");
  });

  it("서술 어미: 받침 있으면 '이에요', 없으면 '예요'", () => {
    expect(copula("경포해수욕장")).toBe("이에요");
    expect(copula("해운대·경포")).toBe("예요");
    expect(copula("이름 확인 못 함")).toBe("이에요");
  });
});
