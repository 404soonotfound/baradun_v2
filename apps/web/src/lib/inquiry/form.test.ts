import { describe, expect, it } from "vitest";

import {
  buildRequest,
  firstErrorField,
  INQUIRY_KINDS,
  KIND_TO_TYPE,
  validateForm,
} from "./form";
import { checkPickedFile, fitSize } from "./photo";

// 데이터 문의 입력 규칙 (BRD-37)

const ok = {
  kind: "mismatch" as const,
  message: "파고가 달라요",
  email: "",
  consent: false,
};

describe("validateForm", () => {
  it("유형·5자 이상 내용이면 통과, 이메일은 선택", () => {
    expect(validateForm(ok)).toEqual({});
  });

  it("유형 없음·5자 미만(공백 제외)은 오류", () => {
    expect(validateForm({ ...ok, kind: null, message: "  네 " })).toEqual({
      kind: "kindMissing",
      message: "messageShort",
    });
  });

  it("이메일을 쓰면 형식과 동의가 필요", () => {
    expect(validateForm({ ...ok, email: "name@" })).toEqual({
      email: "emailFormat",
      consent: "consentMissing",
    });
    expect(
      validateForm({ ...ok, email: "name@example.com", consent: true }),
    ).toEqual({});
    expect(
      validateForm({ ...ok, email: "a b@example.com", consent: true }),
    ).toEqual({
      email: "emailFormat",
    });
  });

  it("첫 오류 칸은 화면 순서", () => {
    expect(
      firstErrorField({ consent: "consentMissing", message: "messageShort" }),
    ).toBe("message");
    expect(firstErrorField({})).toBeNull();
  });
});

describe("buildRequest", () => {
  it("화면 유형 칩 4개는 계약 유형 4개와 1:1(결정 21)", () => {
    const types = INQUIRY_KINDS.map((kind) => KIND_TO_TYPE[kind]);
    expect(new Set(types).size).toBe(INQUIRY_KINDS.length);
    expect(KIND_TO_TYPE).toEqual({
      mismatch: "data_error",
      addBeach: "beach_request",
      criteria: "data_question",
      newData: "data_suggestion",
    });
  });

  it("해변·활동은 본문에 섞지 않고 계약 칸으로, 없으면 칸을 만들지 않음(결정 22)", () => {
    expect(
      buildRequest({
        kind: "mismatch",
        message: "  파고가 달라요 ",
        email: "",
        context: { beachId: "b0001", activity: "surfing" },
      }),
    ).toEqual({
      type: "data_error",
      message: "파고가 달라요",
      beachId: "b0001",
      activity: "surfing",
    });
    const plain = buildRequest({
      kind: "addBeach",
      message: "m",
      email: "  ",
      context: null,
    });
    expect(plain).toEqual({ type: "beach_request", message: "m" });
    expect(plain).not.toHaveProperty("beachId");
    expect(plain).not.toHaveProperty("activity");
  });

  it("이메일은 앞뒤 공백을 빼고 보냄", () => {
    expect(
      buildRequest({
        kind: "criteria",
        message: "m",
        email: " a@b.co ",
        context: null,
      }).email,
    ).toBe("a@b.co");
  });
});

describe("사진 준비 규칙", () => {
  it("긴 변을 2048px로 줄이고 작으면 그대로", () => {
    expect(fitSize(4096, 3072)).toEqual({ width: 2048, height: 1536 });
    expect(fitSize(1000, 3000)).toEqual({ width: 683, height: 2048 });
    expect(fitSize(800, 600)).toEqual({ width: 800, height: 600 });
  });

  it("사진이 아니거나 20MiB 넘는 원본은 받지 않음", () => {
    expect(checkPickedFile({ type: "video/mp4", size: 10 })).toBe("notImage");
    expect(checkPickedFile({ type: "", size: 10 })).toBe("notImage");
    expect(
      checkPickedFile({ type: "image/heic", size: 21 * 1024 * 1024 }),
    ).toBe("tooLarge");
    expect(checkPickedFile({ type: "image/jpeg", size: 1024 })).toBeNull();
  });
});
