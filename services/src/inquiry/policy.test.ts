import { describe, expect, it } from "vitest";
import {
  INQUIRY_BODY_RETENTION_DAYS,
  INQUIRY_EMAIL_RETENTION_DAYS,
  INQUIRY_MAX_PHOTO_BYTES,
  INQUIRY_MAX_PHOTOS,
  INQUIRY_NOTIFICATION_LIMIT_PER_DAY,
  INQUIRY_PHOTO_RETENTION_DAYS,
  INQUIRY_RATE_LIMIT_PER_MINUTE,
  kstDate,
  ttlAfterDays,
} from "./policy";

describe("문의 보존·비용 제한", () => {
  it("확정 수치를 유지한다", () => {
    expect(INQUIRY_BODY_RETENTION_DAYS).toBe(90);
    expect(INQUIRY_EMAIL_RETENTION_DAYS).toBe(88);
    expect(INQUIRY_PHOTO_RETENTION_DAYS).toBe(30);
    expect(INQUIRY_MAX_PHOTOS).toBe(3);
    expect(INQUIRY_MAX_PHOTO_BYTES).toBe(4 * 1024 * 1024);
    expect(INQUIRY_RATE_LIMIT_PER_MINUTE).toBe(10);
    expect(INQUIRY_NOTIFICATION_LIMIT_PER_DAY).toBe(20);
  });

  it("TTL을 초 단위 절대 시각으로 만든다", () => {
    const now = new Date("2026-10-26T00:00:00.500Z");
    expect(ttlAfterDays(now, 88)).toBe(1800576000);
    expect(ttlAfterDays(now, 90)).toBe(1800748800);
  });

  it("알림 날짜를 한국 시각으로 나눈다", () => {
    expect(kstDate(new Date("2026-10-25T15:00:00.000Z"))).toBe("2026-10-26");
  });
});
