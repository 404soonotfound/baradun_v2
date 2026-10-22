import { describe, expect, it } from "vitest";
import { checkConfirmation } from "./confirmation";
import { WARNING_POLICY } from "./policy";

// 특보 확인 유효시간 검사 (BRD-18, 아키텍처 14.3 테스트 경계)

const LAST = "2026-10-22T03:03:00Z"; // :03 수집 슬롯에서 정상 전체 확인

describe("WARNING_POLICY", () => {
  it("유효시간은 45분", () => {
    expect(WARNING_POLICY.confirmationTtlMs).toBe(2_700_000);
  });
});

describe("checkConfirmation", () => {
  it.each([
    ["2026-10-22T03:03:00Z", "확인 직후"],
    ["2026-10-22T03:47:59Z", "44분 59초"],
    ["2026-10-22T03:48:00Z", "45분 00초 경계"],
  ])("유효: %s (%s)", (now) => {
    expect(checkConfirmation(LAST, now)).toEqual({
      confirmed: true,
      validUntil: "2026-10-22T03:48:00Z",
    });
  });

  it("확인 시각에 밀리초가 있어도 validUntil은 초 단위로 내림", () => {
    expect(
      checkConfirmation("2026-10-22T03:03:00.500Z", "2026-10-22T03:10:00Z"),
    ).toEqual({ confirmed: true, validUntil: "2026-10-22T03:48:00Z" });
  });

  it("내린 validUntil이 지나면 밀리초 경과가 45분 안이어도 만료", () => {
    // 경과 44분 59.8초지만 validUntil 03:48:00Z가 이미 지남 → confirmed로 지난 시각을 내보내지 않음
    expect(
      checkConfirmation("2026-10-22T03:03:00.700Z", "2026-10-22T03:48:00.500Z"),
    ).toEqual({ confirmed: false, reason: "expired" });
  });

  it.each([
    ["2026-10-22T03:48:01Z", "45분 01초 경계"],
    ["2026-10-22T03:48:00.001Z", "45분 00.001초"],
    ["2026-10-22T05:00:00Z", "한참 지남"],
  ])("만료: %s (%s)", (now) => {
    expect(checkConfirmation(LAST, now)).toEqual({
      confirmed: false,
      reason: "expired",
    });
  });

  it("정상 전체 확인이 없었음", () => {
    expect(checkConfirmation(null, LAST)).toEqual({
      confirmed: false,
      reason: "never",
    });
  });

  it.each([
    "2026-10-22T12:03:00+09:00", // KST 표기
    "2026-10-22T03:03:00", // 시간대 없음
    "2026-10-22", // 날짜만
    "2026-02-30T03:03:00Z", // 달력에 없는 날짜
    "",
  ])("저장된 확인 시각이 잘못됨: %j", (last) => {
    expect(checkConfirmation(last, LAST)).toEqual({
      confirmed: false,
      reason: "invalid",
    });
  });

  it("확인 시각이 기준 시각보다 늦음", () => {
    expect(checkConfirmation("2026-10-22T03:04:00Z", LAST)).toEqual({
      confirmed: false,
      reason: "future",
    });
  });

  it("기준 시각이 잘못되면 멈춤", () => {
    expect(() => checkConfirmation(LAST, "2026-10-22 03:03")).toThrow(
      RangeError,
    );
  });
});
