import { describe, expect, it } from "vitest";
import { readMetricValue, type MetricKey } from "./values";

// 관측 값 검사 (BRD-19 부품 1, 결정 기록 11장 10/22)

describe("readMetricValue", () => {
  it.each<[MetricKey, string, number]>([
    ["waveHeight", "0.8", 0.8],
    ["waveHeight", "0.0", 0], // 0.0은 정상값
    ["wind", "  6.3 ", 6.3], // 앞뒤 빈칸은 지움
    ["wavePeriod", "3.6", 3.6],
    ["waveDirection", "0", 0], // 0°·360° 모두 실응답에 있음
    ["waveDirection", "360", 360],
    ["waterTemp", "-1.5", -1.5], // 영하 수온은 정상값
  ])("%s %j → %d", (key, raw, value) => {
    expect(readMetricValue(key, raw)).toBe(value);
  });

  it.each<[MetricKey, string]>([
    ["waveHeight", "-99.0"], // 결측 표기
    ["waterTemp", "-99.0"],
    ["waveDirection", "-99"],
    ["waveHeight", "-0.1"], // 음수
    ["wind", "-1.0"],
    ["wavePeriod", "0.0"], // 0초
    ["waveDirection", "-1"], // 범위 밖(실응답 16건)
    ["waveDirection", "361"],
    ["waveHeight", ""], // 빈 값
    ["waveHeight", "1e3"], // 숫자 모양이 아님
    ["waveHeight", "abc"],
  ])("%s %j → null", (key, raw) => {
    expect(readMetricValue(key, raw)).toBeNull();
  });
});
