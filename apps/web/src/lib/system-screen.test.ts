import { describe, expect, it } from "vitest";

import { maintenanceUntil, systemScreen } from "./system-screen";

// 시스템 화면 (BRD-38)

describe("systemScreen", () => {
  it("점검·강제 업데이트만 전체를 덮음", () => {
    expect(systemScreen("maintenance")).toBe("maintenance");
    expect(systemScreen("update_required")).toBe("update_required");
  });

  it("그 밖의 상태(지원 밖 형식은 배너)는 덮지 않음", () => {
    expect(systemScreen("loading")).toBeNull();
    expect(systemScreen("ready")).toBeNull();
    expect(systemScreen("schema_unsupported")).toBeNull();
  });
});

describe("maintenanceUntil", () => {
  const now = Date.parse("2026-10-27T05:40:00Z"); // 한국 14:40

  it("예정 시각을 한국 시각으로. 날짜가 다르면 날짜도", () => {
    expect(maintenanceUntil("2026-10-27T07:00:00Z", now)).toBe("16:00");
    expect(maintenanceUntil("2026-10-27T16:00:00Z", now)).toBe("10/28 01:00");
  });

  it("이미 지난 예정 시각은 보여주지 않음(2분 여유)", () => {
    expect(maintenanceUntil("2026-10-27T05:39:00Z", now)).toBe("14:39");
    expect(maintenanceUntil("2026-10-27T05:38:00Z", now)).toBeNull();
    expect(maintenanceUntil("2026-10-27T03:00:00Z", now)).toBeNull();
  });

  it("없거나 읽을 수 없거나 지금 시각을 모르면 null", () => {
    expect(maintenanceUntil(null, now)).toBeNull();
    expect(maintenanceUntil(undefined, now)).toBeNull();
    expect(maintenanceUntil("2026-10-27 07:00", now)).toBeNull();
    expect(maintenanceUntil("2026-10-27T07:00:00Z", NaN)).toBeNull();
  });
});
