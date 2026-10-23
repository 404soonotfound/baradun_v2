import { describe, expect, it } from "vitest";

import { kstStamp, minutesAgo } from "./clock";

// 시각 문구 값 검사 (BRD-76: B5 확인 시각에 날짜 표시)
// 한국 시각 기준 오늘이면 "14:05", 날짜가 다르면 "10/20 14:05"
// 오프라인으로 며칠 전 스냅샷을 열어도 오늘 확인한 것처럼 읽히지 않게 함

const at = (iso: string) => Date.parse(iso);

describe("kstStamp", () => {
  const now = at("2026-10-21T06:00:00Z"); // KST 10/21 15:00

  it("한국 시각으로 같은 날이면 시:분만 보인다", () => {
    expect(kstStamp("2026-10-21T05:05:00Z", now)).toBe("14:05");
  });

  it("한국 시각으로 날짜가 다르면 월/일을 붙인다", () => {
    expect(kstStamp("2026-10-20T05:05:00Z", now)).toBe("10/20 14:05");
    expect(kstStamp("2026-10-18T05:05:00Z", now)).toBe("10/18 14:05");
  });

  it("UTC 날짜가 아니라 한국 날짜로 비교한다", () => {
    // UTC로는 같은 10/20이지만 KST로는 10/20 23:50과 10/21 00:10
    const kstAfterMidnight = at("2026-10-20T15:10:00Z");
    expect(kstStamp("2026-10-20T14:50:00Z", kstAfterMidnight)).toBe(
      "10/20 23:50",
    );
    // UTC로는 10/20·10/21로 다르지만 KST로는 같은 10/21
    expect(kstStamp("2026-10-20T15:30:00Z", at("2026-10-21T01:00:00Z"))).toBe(
      "00:30",
    );
  });

  it("시간대가 붙은 다른 표기도 한국 시각으로 바꾼다", () => {
    expect(kstStamp("2026-10-21T14:05:00+09:00", now)).toBe("14:05");
  });

  it("시각을 읽을 수 없거나 지금 시각을 모르면 null (시각을 지어내지 않음)", () => {
    expect(kstStamp(null, now)).toBeNull();
    expect(kstStamp(undefined, now)).toBeNull();
    expect(kstStamp("2026-10-21T05:05:00", now)).toBeNull(); // 시간대 없음
    expect(kstStamp("2026-02-30T05:05:00Z", now)).toBeNull(); // 없는 날짜
    expect(kstStamp("2026-10-21T05:05:00Z", NaN)).toBeNull();
  });
});

describe("minutesAgo", () => {
  const now = at("2026-10-21T06:00:00Z");

  it("지난 시간을 분 단위로 내린다", () => {
    expect(minutesAgo("2026-10-21T05:49:01Z", now)).toBe(10);
  });

  it("1분 미만이거나 측정 시각이 조금 뒤여도 1 (0분·음수를 보이지 않음)", () => {
    expect(minutesAgo("2026-10-21T05:59:30Z", now)).toBe(1);
    expect(minutesAgo("2026-10-21T06:01:00Z", now)).toBe(1);
  });

  it("시각을 읽을 수 없으면 null", () => {
    expect(minutesAgo(null, now)).toBeNull();
    expect(minutesAgo("bad", now)).toBeNull();
  });
});
