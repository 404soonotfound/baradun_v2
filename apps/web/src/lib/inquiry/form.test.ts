import { describe, expect, it } from "vitest";

import {
  buildRequest,
  composeMessage,
  firstErrorField,
  KIND_TO_TYPE,
  MESSAGE_INPUT_MAX,
  MESSAGE_MAX,
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

describe("composeMessage·buildRequest", () => {
  it("머리 줄에 유형·해변·활동, 빈 해변은 빼고 2000자를 넘지 않음", () => {
    expect(
      composeMessage({
        kindLabel: "정보가 실제와 달라요",
        beachName: "경포해변",
        activityLabel: "수영",
        message: "  파고가 달라요 ",
      }),
    ).toBe("[정보가 실제와 달라요 · 경포해변 · 수영]\n\n파고가 달라요");
    expect(
      composeMessage({
        kindLabel: "x",
        beachName: null,
        activityLabel: null,
        message: "a".repeat(3000),
      }).length,
    ).toBe(MESSAGE_MAX);
  });

  it("머리 줄이 아무리 길어도 내용 입력 상한까지 쓴 글은 끝까지 보냄", () => {
    const message = `${"가".repeat(MESSAGE_INPUT_MAX - 3)}끝말`;
    const composed = composeMessage({
      kindLabel: "유".repeat(200),
      beachName: "해".repeat(200),
      activityLabel: "활동",
      message,
    });
    expect(composed.length).toBeLessThanOrEqual(MESSAGE_MAX);
    expect(composed.endsWith(message)).toBe(true);
  });

  it("빈 이메일은 보내지 않고, 유형은 계약 값으로", () => {
    expect(
      buildRequest({ kind: "addBeach", message: "m", email: "  ", photos: [] }),
    ).toEqual({
      type: "other",
      message: "m",
      photos: [],
    });
    expect(
      buildRequest({
        kind: "criteria",
        message: "m",
        email: " a@b.co ",
        photos: [],
      }).email,
    ).toBe("a@b.co");
    expect(KIND_TO_TYPE.mismatch).toBe("data_error");
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
