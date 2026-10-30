import { describe, expect, it } from "vitest";

import { inquiryReturn } from "./return-path";

// 문의 접수 뒤 돌아갈 곳 (BRD-129 · 10/30 사용자 결정 A)
const beaches = [{ slug: "gangmun" }, { slug: "gyeongpo" }];

describe("inquiryReturn", () => {
  it("공개 해변 slug로 들어왔으면 그 해변 상세", () => {
    expect(inquiryReturn("gangmun", beaches)).toEqual({
      kind: "beach",
      path: "/spots/gangmun/",
    });
  });

  it("쿼리가 없으면 설정", () => {
    expect(inquiryReturn(null, beaches)).toEqual({
      kind: "settings",
      path: "/settings/",
    });
  });

  it("빈 값·공백이면 설정", () => {
    expect(inquiryReturn("", beaches).kind).toBe("settings");
    expect(inquiryReturn("  ", beaches).kind).toBe("settings");
  });

  it("공개 목록에 없는 slug(모르는 값·노출 끈 해변)면 설정", () => {
    expect(inquiryReturn("nope", beaches).kind).toBe("settings");
    expect(inquiryReturn("gangmun/../x", beaches).kind).toBe("settings");
  });

  it("해변 목록이 비어 있으면 설정", () => {
    expect(inquiryReturn("gangmun", []).kind).toBe("settings");
  });
});
