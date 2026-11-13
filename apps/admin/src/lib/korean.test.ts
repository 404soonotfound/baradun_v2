import { describe, expect, it } from "vitest";
import { topicParticle } from "./korean";

describe("조사·어미", () => {
  it("주제 조사: 받침 있으면 '은', 없으면 '는'", () => {
    expect(topicParticle("들어온 경로")).toBe("는");
    expect(topicParticle("많이 본 화면")).toBe("은");
    expect(topicParticle("앞 기간 비교")).toBe("는");
    expect(topicParticle("abc")).toBe("는");
    expect(topicParticle("")).toBe("는");
  });
});
