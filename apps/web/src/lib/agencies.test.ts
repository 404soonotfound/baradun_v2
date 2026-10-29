import { describe, expect, it } from "vitest";

import { AGENCY, agencyKeyOf, SOURCE_URL } from "./agencies";

// 아는 기관 표 (BRD-113)
describe("agencyKeyOf", () => {
  it("아는 기관 원문은 키로", () => {
    expect(agencyKeyOf("기상청")).toBe("kma");
    expect(agencyKeyOf("국립해양조사원")).toBe("khoa");
    expect(agencyKeyOf("한국관광공사")).toBe("kto");
  });

  it("모르는 기관·빈 값·비슷한 이름은 null(지어내지 않음)", () => {
    expect(agencyKeyOf("")).toBeNull();
    expect(agencyKeyOf("기상청 ")).toBeNull();
    expect(agencyKeyOf("KMA")).toBeNull();
    expect(agencyKeyOf("해양수산부")).toBeNull();
  });

  it("표의 모든 원문이 자기 키로 돌아옴", () => {
    for (const [key, name] of Object.entries(AGENCY)) {
      expect(agencyKeyOf(name)).toBe(key);
    }
  });
});

describe("SOURCE_URL", () => {
  it("공공데이터포털 원문 주소(https)", () => {
    expect(SOURCE_URL).toEqual({
      ripCurrent: "https://www.data.go.kr/data/15156028/openapi.do",
      surfing: "https://www.data.go.kr/data/15142490/openapi.do",
      tourApi: "https://www.data.go.kr/data/15101578/openapi.do",
    });
  });
});
