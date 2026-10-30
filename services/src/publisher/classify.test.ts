import { createRequire } from "node:module";
import type { WarningItem } from "@baradun/contracts";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { describe, expect, it } from "vitest";
import type { BeachMetrics } from "../core/observations/beach-metrics";
import { classifyBeach, type ClassifyInput } from "./classify";

// 해변 분류 (BRD-21). 화면 설계서 5장 '검수용 사례' 중 게시 시점에 정해지는 것
// 오프라인·스냅샷 만료(B5)는 화면이 처리 → apps/web 테스트 범위
const NOW = "2026-10-22T05:20:00Z";
const CONFIRMED = "2026-10-22T05:18:40Z";

// 결과가 공개 계약 BeachStatus를 지키는지 함께 확인(info는 게시 단계에서 붙임)
// 패키지 경계를 지켜 contracts가 내보낸 스키마를 읽음
const schema = createRequire(import.meta.url)("@baradun/contracts/schema.json");
const ajv = new Ajv2020({ allowUnionTypes: true, strictTypes: false });
addFormats(ajv);
ajv.addSchema(schema);
const checkStatus = ajv.getSchema(`${schema.$id}#/$defs/BeachStatus`)!;
const INFO = { season: null, ripCurrent: null, nearbyWarnings: [] };

const metric = (
  state: "fresh" | "delayed" | "none",
  unit: "m" | "s" | "deg" | "°C" | "m/s",
  observedAt: string | null = null,
) => ({
  value: state === "none" || observedAt === null ? null : 1,
  unit,
  observedAt: state === "none" ? null : observedAt,
  state,
  nextExpectedAt: null,
  expiresAt:
    state === "none" || observedAt === null
      ? null
      : new Date(Date.parse(observedAt) + 90 * 60 * 1000)
          .toISOString()
          .replace(/\.\d{3}Z$/, "Z"),
});
const metrics = (
  wave: "fresh" | "delayed" | "none",
  period: "fresh" | "delayed" | "none" = "fresh",
): BeachMetrics => ({
  waveHeight: metric(
    wave,
    "m",
    wave === "delayed" ? "2026-10-22T03:30:00Z" : "2026-10-22T05:00:00Z",
  ),
  wavePeriod: metric(
    period,
    "s",
    period === "delayed" ? "2026-10-22T04:00:00Z" : "2026-10-22T05:10:00Z",
  ),
  waveDirection: metric("fresh", "deg", "2026-10-22T05:10:00Z"),
  waterTemp: metric("fresh", "°C", "2026-10-22T05:00:00Z"),
  wind: metric("fresh", "m/s", "2026-10-22T05:00:00Z"),
});

const windWave = (
  level: WarningItem["level"],
  publishedAt: string,
): WarningItem => ({
  type: "wind_wave",
  level,
  zoneCode: "S1311100",
  zoneName: "부산앞바다",
  publishedAt,
  effectiveFrom: publishedAt,
});

function input(over: Partial<ClassifyInput> = {}): ClassifyInput {
  return {
    warnings: { state: "none", items: [], nearby: [], reasons: [] },
    tsunami: { items: [], reasons: [] },
    tsunamiUnreadable: false,
    metrics: metrics("fresh"),
    seaZoneName: "부산앞바다",
    waveStationName: "기장 파고부이",
    lastConfirmedAt: { pwn: CONFIRMED, tsunami: CONFIRMED },
    now: NOW,
    ...over,
  };
}

function classify(over: Partial<ClassifyInput> = {}) {
  const result = classifyBeach(input(over));
  expect(
    checkStatus({ ...result, info: INFO }),
    JSON.stringify(checkStatus.errors),
  ).toBe(true);
  return result;
}

const active = (items: WarningItem[]) => ({
  state: "active" as const,
  items,
  nearby: [],
  reasons: [],
});
const unknownWarnings = {
  state: "unknown" as const,
  items: [],
  nearby: [],
  reasons: ["confirmation:expired"],
};

describe("classifyBeach 검수용 사례", () => {
  it("특보 없음 + 파고 최신 → 특보 없음", () => {
    const result = classify();
    expect(result.category).toBe("clear");
    expect(result.reasons).toEqual([]);
    expect(result.warning).toEqual({
      state: "none",
      items: [],
      source: "기상청",
      lastConfirmedAt: CONFIRMED,
    });
    expect(result.control).toEqual({ state: "not_provided" });
  });

  it("특보 없음 + 가까운 관측 없음 → 특보 없음(측정소 없음은 분류 영향 없음)", () => {
    const result = classify({
      metrics: metrics("none", "none"),
      waveStationName: null,
    });
    expect(result.category).toBe("clear");
  });

  it.each([
    ["지연", "delayed"],
    ["최신", "fresh"],
  ] as const)("특보 발효 + 파고 %s → 특보 이름(이용불가)", (_name, wave) => {
    const result = classify({
      warnings: active([windWave("advisory", "2026-10-22T04:00:00Z")]),
      metrics: metrics(wave),
    });
    expect(result.category).toBe("unavailable");
    expect(result.reasons).toEqual([
      {
        code: "warning",
        type: "wind_wave",
        level: "advisory",
        scope: "부산앞바다",
        source: "기상청",
        at: "2026-10-22T04:00:00Z",
      },
    ]);
  });

  it("특보 확인 못 함 + 파고 지연 → 특보 확인 못 함 먼저, 관측 지연 다음", () => {
    const result = classify({
      warnings: unknownWarnings,
      metrics: metrics("delayed"),
    });
    expect(result.category).toBe("undetermined");
    expect(result.reasons).toEqual([
      {
        code: "warning_unknown",
        scope: "부산앞바다",
        source: "기상청",
        at: CONFIRMED,
      },
      {
        code: "observation_delayed",
        scope: "기장 파고부이",
        source: "기상청",
        at: "2026-10-22T03:30:00Z",
      },
    ]);
  });

  it("특보 없음 + 파고 지연 → 관측 지연", () => {
    const result = classify({ metrics: metrics("delayed") });
    expect(result.category).toBe("undetermined");
    expect(result.reasons.map((r) => r.code)).toEqual(["observation_delayed"]);
    expect(result.warning.state).toBe("none");
  });

  it("특보 없음 + 파고 최신 + 파주기 지연 → 특보 없음(B4)", () => {
    expect(classify({ metrics: metrics("fresh", "delayed") }).category).toBe(
      "clear",
    );
  });

  it("주변 특보(호우·열대야)만 발효 → 특보 없음(B3)", () => {
    const result = classify({
      warnings: {
        state: "none",
        items: [],
        nearby: [
          {
            type: "heavy_rain",
            level: "warning",
            zoneCode: "L1082500",
            zoneName: "부산동부",
            publishedAt: "2026-10-22T04:00:00Z",
            effectiveFrom: "2026-10-22T04:00:00Z",
          },
        ],
        reasons: [],
      },
    });
    expect(result.category).toBe("clear");
    expect(result.warning.items).toEqual([]);
  });

  it("중대경보 발효 → 이용불가", () => {
    const result = classify({
      warnings: active([windWave("severe_warning", "2026-10-22T04:00:00Z")]),
    });
    expect(result.category).toBe("unavailable");
    expect(result.reasons[0]?.level).toBe("severe_warning");
  });

  it("지진해일 경보가 해변과 짝지어짐 → 이용불가", () => {
    const tsunamiItem: WarningItem = {
      type: "tsunami",
      level: "warning",
      zoneCode: null,
      zoneName: "동해안",
      publishedAt: "2026-10-22T05:00:00Z",
      effectiveFrom: "2026-10-22T05:00:00Z",
    };
    const result = classify({ tsunami: { items: [tsunamiItem], reasons: [] } });
    expect(result.category).toBe("unavailable");
    expect(result.reasons[0]).toMatchObject({
      type: "tsunami",
      scope: "동해안",
    });
  });

  it("지진해일 지역 글을 못 읽음 → 특보 확인 못 함, 다른 특보 발효 해변은 이용불가 유지", () => {
    expect(classify({ tsunamiUnreadable: true }).category).toBe("undetermined");
    expect(
      classify({
        tsunamiUnreadable: true,
        warnings: active([windWave("advisory", "2026-10-22T04:00:00Z")]),
      }).category,
    ).toBe("unavailable");
  });
});

describe("classifyBeach 규칙", () => {
  it("여러 특보는 단계 높은 순, 같은 단계는 발표 이른 순(getPwnCd·지진해일 섞임)", () => {
    const tsunamiAdvisory: WarningItem = {
      type: "tsunami",
      level: "advisory",
      zoneCode: null,
      zoneName: "남해안",
      publishedAt: "2026-10-22T03:00:00Z",
      effectiveFrom: "2026-10-22T03:00:00Z",
    };
    const result = classify({
      warnings: active([
        windWave("advisory", "2026-10-22T04:00:00Z"),
        windWave("warning", "2026-10-22T04:30:00Z"),
      ]),
      tsunami: { items: [tsunamiAdvisory], reasons: [] },
    });
    expect(result.reasons.map((r) => [r.level, r.at])).toEqual([
      ["warning", "2026-10-22T04:30:00Z"],
      ["advisory", "2026-10-22T03:00:00Z"],
      ["advisory", "2026-10-22T04:00:00Z"],
    ]);
  });

  it("지진해일만 확인 못 함이어도 특보 확인 못 함", () => {
    const result = classify({
      tsunami: { items: [], reasons: ["tsunami:confirmation:expired"] },
    });
    expect(result.category).toBe("undetermined");
    expect(result.warning.state).toBe("unknown");
  });

  it.each([
    ["지진해일 확인 없음", { pwn: CONFIRMED, tsunami: null }, NOW],
    [
      "확인 45분 지남",
      { pwn: CONFIRMED, tsunami: CONFIRMED },
      "2026-10-22T06:10:00Z",
    ],
  ] as const)(
    "앞 단계 사유가 비어도 %s → 특보 확인 못 함(특보 없음으로 내보내지 않음)",
    (_name, lastConfirmedAt, now) => {
      const result = classify({ lastConfirmedAt, now });
      expect(result.category).toBe("undetermined");
      expect(result.warning.state).toBe("unknown");
      expect(result.reasons.map((r) => r.code)).toEqual(["warning_unknown"]);
    },
  );

  it("발효 특보가 있으면 확인 못 함 사유가 있어도 이용불가(사유는 특보만)", () => {
    const result = classify({
      warnings: {
        ...active([windWave("advisory", "2026-10-22T04:00:00Z")]),
        reasons: ["zone_unverified:L1000000"],
      },
      metrics: metrics("delayed"),
    });
    expect(result.reasons.map((r) => r.code)).toEqual(["warning"]);
  });

  it("발효 특보 + 특보 확인 45분 경과 → 이용불가 유지(B5), validUntil은 게시 시각, 확인 시각은 마지막 확인", () => {
    const result = classify({
      warnings: {
        ...active([windWave("advisory", "2026-10-22T04:00:00Z")]),
        reasons: ["confirmation:expired"],
      },
      now: "2026-10-22T06:10:00Z", // CONFIRMED(05:18:40) + 51분 20초
    });
    expect(result.category).toBe("unavailable");
    expect(result.warning.state).toBe("active");
    expect(result.warning.lastConfirmedAt).toBe(CONFIRMED);
    expect(result.reasons.map((r) => r.code)).toEqual(["warning"]);
    expect(result.validUntil).toBe("2026-10-22T06:10:00Z");
  });
});

describe("classifyBeach validUntil", () => {
  it("파고 fresh → min(파고 만료, 확인 + 45분)", () => {
    // 확인 05:18:40 + 45분 = 06:03:40, 파고 05:00 + 90분 = 06:30 → 06:03:40
    expect(classify().validUntil).toBe("2026-10-22T06:03:40Z");
    // 확인이 늦으면 파고 만료가 더 이름
    expect(
      classify({
        lastConfirmedAt: {
          pwn: "2026-10-22T05:50:00Z",
          tsunami: "2026-10-22T05:50:00Z",
        },
        now: "2026-10-22T05:55:00Z",
      }).validUntil,
    ).toBe("2026-10-22T06:30:00Z");
  });

  it.each([
    ["파고 지연(10/17)", "delayed"],
    ["파고 측정소 없음(10/22)", "none"],
  ] as const)("%s → 확인 + 45분만", (_name, wave) => {
    expect(classify({ metrics: metrics(wave) }).validUntil).toBe(
      "2026-10-22T06:03:40Z",
    );
  });

  it("두 출처 중 이른 확인 시각을 씀", () => {
    const result = classify({
      lastConfirmedAt: { pwn: CONFIRMED, tsunami: "2026-10-22T05:00:00Z" },
    });
    expect(result.validUntil).toBe("2026-10-22T05:45:00Z");
    expect(result.warning.lastConfirmedAt).toBe("2026-10-22T05:00:00Z");
  });

  it("한쪽이라도 확인된 적이 없으면 게시 시각(바로 만료)", () => {
    const result = classify({
      warnings: unknownWarnings,
      lastConfirmedAt: { pwn: CONFIRMED, tsunami: null },
    });
    expect(result.validUntil).toBe(NOW);
    expect(result.warning.lastConfirmedAt).toBe(CONFIRMED);
  });

  it("확인이 45분을 지났거나 미래 시각이면 게시 시각(바로 만료)", () => {
    // 05:18:40 + 45분 = 06:03:40 < 06:10 → 지남
    const expired = classify({
      warnings: unknownWarnings,
      now: "2026-10-22T06:10:00Z",
    });
    expect(expired.validUntil).toBe("2026-10-22T06:10:00Z");
    // 기준 시각보다 늦은 확인 → 믿지 않음
    const future = classify({
      warnings: unknownWarnings,
      now: "2026-10-22T05:10:00Z",
    });
    expect(future.validUntil).toBe("2026-10-22T05:10:00Z");
  });

  it("깨진 확인 시각은 확인 못 한 것으로 보고 표시하지 않음", () => {
    const result = classify({
      warnings: unknownWarnings,
      lastConfirmedAt: { pwn: "2026-10-22 05:18", tsunami: CONFIRMED },
    });
    expect(result.validUntil).toBe(NOW);
    expect(result.warning.lastConfirmedAt).toBe(CONFIRMED);
  });

  it("둘 다 확인된 적 없는데 발효 특보만 있으면 게시를 멈춤", () => {
    expect(() =>
      classifyBeach(
        input({
          warnings: active([windWave("advisory", "2026-10-22T04:00:00Z")]),
          lastConfirmedAt: { pwn: null, tsunami: null },
        }),
      ),
    ).toThrow(RangeError);
  });

  it("파고 관측 지연인데 측정소 이름이 없으면 게시를 멈춤(구역 이름으로 바꾸지 않음)", () => {
    expect(() =>
      classifyBeach(
        input({ metrics: metrics("delayed"), waveStationName: null }),
      ),
    ).toThrow(RangeError);
  });

  it.each([
    ["지진해일", { pwn: CONFIRMED, tsunami: "2026-10-22T06:00:00Z" }],
    ["getPwnCd", { pwn: "2026-10-22T06:00:00Z", tsunami: CONFIRMED }],
  ] as const)(
    "%s 확인 시각만 미래여도 게시 시각(이른 시각에 가려지지 않음)",
    (_name, lastConfirmedAt) => {
      const result = classify({ lastConfirmedAt });
      expect(result.validUntil).toBe(NOW);
      expect(result.category).toBe("undetermined");
    },
  );
});
