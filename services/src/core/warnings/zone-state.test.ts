import { describe, expect, it } from "vitest";
import data from "./fixtures/pwncd-events.json";
import { normalizePwnCdRow, type PwnCdRow } from "./normalize";
import { applyZoneStates } from "./zone-state";

// 구역별 상태 검사 (BRD-54 8단계 · T02 상태 적용 · T05 정정·역전 방지)

const row = (id: string): PwnCdRow => {
  const found = data.cases.find((c) => c.id === id);
  if (!found) throw new Error(`픽스처 없음: ${id}`);
  return found.row;
};
const scenario: PwnCdRow[] = data.scenarios[0]!.rows;

const states = (rows: PwnCdRow[], now: string) =>
  applyZoneStates(rows.map(normalizePwnCdRow), now);

// 한 구역·종류만 나오는 입력에서 그 상태
const statusOf = (rows: PwnCdRow[], now: string) => {
  const result = states(rows, now);
  expect(result).toHaveLength(1);
  return result[0]!.status;
};

describe("T02 · S1152010 풍랑 시나리오", () => {
  // 발표 10-14 00:00 KST(발효 02:00) → 경보로 변경 07:00(발효 09:00)
  // → 주의보로 변경 13:00(발효 14:00) → 해제 10-15 01:00(발효 03:00). 아래 시각은 UTC
  const advisory = {
    state: "active",
    level: "advisory",
    publishedAt: "2026-10-13T15:00:00Z",
    effectiveFrom: "2026-10-13T17:00:00Z",
  };

  it("첫 발표 전: 상태 없음", () => {
    expect(states(scenario, "2026-10-13T14:59:00Z")).toEqual([]);
  });

  it("발표 후 발효 전: 발효 예고", () => {
    expect(statusOf(scenario, "2026-10-13T16:00:00Z")).toEqual({
      ...advisory,
      state: "pending",
    });
  });

  it("발효 중: 주의보", () => {
    const result = states(scenario, "2026-10-13T17:00:00Z");
    expect(result).toEqual([
      {
        zone: { kind: "code", code: "S1152010", scope: "sea" },
        kind: { group: "judged", type: "wind_wave" },
        status: advisory,
      },
    ]);
  });

  it("경보로 변경 발표 후 발효 전: 주의보 유지", () => {
    expect(statusOf(scenario, "2026-10-13T23:00:00Z")).toEqual(advisory);
  });

  it("경보 중", () => {
    expect(statusOf(scenario, "2026-10-14T02:00:00Z")).toEqual({
      state: "active",
      level: "warning",
      publishedAt: "2026-10-13T22:00:00Z",
      effectiveFrom: "2026-10-14T00:00:00Z",
    });
  });

  it("주의보로 다시 변경 발효 후: 주의보", () => {
    expect(statusOf(scenario, "2026-10-14T10:00:00Z")).toEqual({
      state: "active",
      level: "advisory",
      publishedAt: "2026-10-14T04:00:00Z",
      effectiveFrom: "2026-10-14T05:00:00Z",
    });
  });

  it("해제 발표 후 해제 발효 전: 계속 발효 중", () => {
    expect(statusOf(scenario, "2026-10-14T17:59:00Z")).toMatchObject({
      state: "active",
      level: "advisory",
    });
  });

  it.each(["2026-10-14T18:00:00Z", "2026-10-15T00:00:00Z"])(
    "해제 발효 후(%s): 해제",
    (now) => {
      expect(statusOf(scenario, now)).toEqual({
        state: "cleared",
        at: "2026-10-14T18:00:00Z",
      });
    },
  );

  it("기준 시각에 밀리초가 붙어도 같음", () => {
    expect(statusOf(scenario, "2026-10-14T18:00:00.000Z")).toMatchObject({
      state: "cleared",
    });
  });
});

describe("T02 · 그 밖의 실데이터", () => {
  it("발효 예고(startTime > 기준 시각)는 아직 발효 아님, 발효 후 발효 중", () => {
    const rows = [row("issue-future-start")];
    expect(statusOf(rows, "2026-08-31T08:00:00Z")).toMatchObject({
      state: "pending",
      effectiveFrom: "2026-08-31T09:00:00Z",
    });
    expect(statusOf(rows, "2026-08-31T09:00:00Z")).toMatchObject({
      state: "active",
    });
    // 주변 특보(열대야)도 같은 규칙, 종류만 nearby
    expect(states(rows, "2026-08-31T09:00:00Z")[0]!.kind).toEqual({
      group: "nearby",
      type: "tropical_night",
    });
  });

  it("즉시 해제(endTime = tmFc): 발표 시각부터 해제", () => {
    const rows = [row("issue-strong-wind-L1"), row("release-immediate-land")];
    expect(statusOf(rows, "2026-10-15T07:59:00Z")).toMatchObject({
      state: "active",
      level: "advisory",
    });
    expect(statusOf(rows, "2026-10-15T08:00:00Z")).toEqual({
      state: "cleared",
      at: "2026-10-15T08:00:00Z",
    });
  });

  it("해제만 보여도 이미 발효된 해제는 해제", () => {
    expect(
      statusOf([row("release-immediate-land")], "2026-10-15T09:00:00Z"),
    ).toMatchObject({ state: "cleared" });
  });

  it("폭풍해일 육상 L1 발표·해제", () => {
    const rows = [row("issue-storm-surge-L1"), row("release-storm-surge-L1")];
    const during = states(rows, "2026-09-09T14:00:00Z");
    expect(during).toEqual([
      {
        zone: { kind: "code", code: "L1091000", scope: "land" },
        kind: { group: "judged", type: "storm_surge" },
        status: {
          state: "active",
          level: "advisory",
          publishedAt: "2026-09-09T13:15:00Z",
          effectiveFrom: "2026-09-09T13:15:00Z",
        },
      },
    ]);
    expect(statusOf(rows, "2026-09-09T14:30:00Z")).toEqual({
      state: "cleared",
      at: "2026-09-09T14:30:00Z",
    });
  });

  it("연장(command 3)은 발효 중", () => {
    expect(statusOf([row("extend")], "2026-09-09T13:00:00Z")).toMatchObject({
      state: "active",
    });
  });

  it("구역·종류마다 따로 계산", () => {
    const result = states(
      [...scenario, row("issue-strong-wind-L1"), row("release-immediate-land")],
      "2026-10-15T00:00:00Z",
    );
    expect(
      result.map((s) => [
        s.zone.kind === "code" && s.zone.code,
        s.status.state,
      ]),
    ).toEqual([
      ["L1014200", "active"],
      ["S1152010", "cleared"],
    ]);
  });
});

describe("T02 · 구역명만 다른 중복 수신 (당진 L1031200 실데이터)", () => {
  // 강풍주의보 발표·호우경보 변경발표 09-01 11:20 KST → 둘 다 해제 13:10 KST
  // 같은 행을 구역명 "당진군"·"당진시"로 두 번씩 받음 → 충돌 아님
  const dangjin: PwnCdRow[] = data.scenarios.find(
    (s) => s.id === "L1031200-2026-09-01-area-name",
  )!.rows;
  const byType = (now: string) =>
    states(dangjin, now).map((s) => [
      s.zone.kind === "code" && s.zone.code,
      s.kind.group !== "unknown" && s.kind.type,
      s.status,
    ]);

  it("KST 12:00: 강풍 주의보·호우 경보 발효 중", () => {
    const active = (level: string) => ({
      state: "active",
      level,
      publishedAt: "2026-09-01T02:20:00Z",
      effectiveFrom: "2026-09-01T02:20:00Z",
    });
    expect(byType("2026-09-01T03:00:00Z")).toEqual([
      ["L1031200", "heavy_rain", active("warning")],
      ["L1031200", "strong_wind", active("advisory")],
    ]);
  });

  it("KST 14:00: 둘 다 해제", () => {
    const cleared = { state: "cleared", at: "2026-09-01T04:10:00Z" };
    expect(byType("2026-09-01T05:00:00Z")).toEqual([
      ["L1031200", "heavy_rain", cleared],
      ["L1031200", "strong_wind", cleared],
    ]);
  });
});

describe("T02 · 합성: 대상·순서를 알 수 없으면 unknown", () => {
  it.each([
    ["correction", "command:6"],
    ["change-release", "command:8"],
    ["cancelled", "cancel:1"],
  ])("%s → unknown(%s), 시나리오에 섞여도 unknown", (id, reason) => {
    const now = "2026-10-14T10:00:00Z";
    expect(statusOf([row(id)], now)).toEqual({
      state: "unknown",
      reasons: [reason],
    });
    expect(statusOf([...scenario, row(id)], now)).toEqual({
      state: "unknown",
      reasons: [reason],
    });
  });

  it("모르는 구역 코드: 그 구역만 unknown", () => {
    const result = states(
      [row("unknown-area-S2"), ...scenario],
      "2026-10-14T10:00:00Z",
    );
    expect(result).toEqual([
      expect.objectContaining({
        zone: { kind: "code", code: "S1152010", scope: "sea" },
        status: expect.objectContaining({ state: "active" }),
      }),
      {
        zone: { kind: "unknown", raw: "S2120500" },
        kind: { group: "judged", type: "wind_wave" },
        status: { state: "unknown", reasons: ["zone:S2120500"] },
      },
    ]);
  });

  it("모르는 특보 종류: 같은 구역의 다른 종류에 번지지 않음", () => {
    const result = states(
      [...scenario, row("unknown-warnVar")],
      "2026-10-14T10:00:00Z",
    );
    expect(result.map((s) => [s.kind, s.status.state])).toEqual([
      [{ group: "unknown", raw: "99" }, "unknown"],
      [{ group: "judged", type: "wind_wave" }, "active"],
    ]);
  });

  it("같은 발표 시각·번호에 다른 발표코드 → 순서 불명 unknown", () => {
    const issue = scenario[0]!;
    const release = { ...issue, command: "2", endTime: issue.startTime };
    expect(statusOf([issue, release], "2026-10-14T10:00:00Z")).toEqual({
      state: "unknown",
      reasons: ["order:202610140000#39"],
    });
  });

  it("예고된 해제만 있고 발표가 안 보이면 unknown", () => {
    expect(statusOf([scenario[3]!], "2026-10-14T17:00:00Z")).toEqual({
      state: "unknown",
      reasons: ["release_without_issue"],
    });
  });

  it("기준 시각 형식이 틀리면 오류", () => {
    expect(() => states(scenario, "어제")).toThrow(RangeError);
  });
});

describe("T05 · 정정·역전 방지", () => {
  const allRows = [
    ...data.cases.filter((c) => c.source !== "synthetic").map((c) => c.row),
    ...scenario,
  ];
  // 고정된 섞기: 뒤집기, 돌리기, 홀짝 나누기
  const orders = [
    [...allRows].reverse(),
    [...allRows.slice(7), ...allRows.slice(0, 7)],
    [
      ...allRows.filter((_, i) => i % 2 === 1),
      ...allRows.filter((_, i) => i % 2 === 0),
    ],
  ];
  const times = [
    "2026-09-09T14:00:00Z",
    "2026-10-13T23:00:00Z",
    "2026-10-14T17:00:00Z",
    "2026-10-16T00:00:00Z",
  ];

  it.each(times)("섞은 순서로 넣어도 결과가 같음 (%s)", (now) => {
    const expected = states(allRows, now);
    for (const order of orders) expect(states(order, now)).toEqual(expected);
  });

  it.each(times)("중복 이벤트가 결과를 바꾸지 않음 (%s)", (now) => {
    const expected = states(allRows, now);
    const doubled = [...allRows, ...allRows.map((r) => ({ ...r }))];
    expect(states(doubled, now)).toEqual(expected);
    expect(states([...orders[0]!, ...allRows], now)).toEqual(expected);
  });

  it("오래된 발표가 나중에 들어와도 더 최신 해제를 되돌리지 않음", () => {
    const now = "2026-10-15T00:00:00Z";
    const olderIssue = { ...scenario[0]!, tmFc: "202610131000", tmSeq: "30" };
    for (const late of [scenario[0]!, scenario[1]!, olderIssue]) {
      expect(statusOf([scenario[3]!, ...scenario, late], now)).toEqual({
        state: "cleared",
        at: "2026-10-14T18:00:00Z",
      });
    }
  });

  it("기준 시각보다 늦게 발표된 이벤트는 반영하지 않음", () => {
    // 경보 중 시점에 해제 이벤트가 들어와 있어도 아직 발표 전
    expect(statusOf(scenario, "2026-10-14T02:00:00Z")).toMatchObject({
      state: "active",
      level: "warning",
    });
  });
});
