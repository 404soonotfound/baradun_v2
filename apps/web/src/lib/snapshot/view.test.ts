import { readFileSync } from "node:fs";

import type { BeachStatus, StatusFile } from "@baradun/contracts";
import { describe, expect, it } from "vitest";

import { clockFromHeaders, DEVICE_CLOCK, type Clock } from "./clock";
import { deriveBeachView, type ViewSource } from "./view";

// 해변 화면 상태 검사 (BRD-41). 입력은 계약 예시 데이터(아키텍처 17.3)
// 예시: b0001 특보 없음 · b0002 풍랑주의보(이용불가) · b0003 관측 지연(판단불가)
//   파고 observedAt 05:00 → expiresAt 06:30, validUntil 06:03:40(특보 확인 05:18:40 + 45분)

const example = JSON.parse(
  readFileSync(
    new URL(
      "../../../../../packages/contracts/examples/valid/status.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as StatusFile;

const TRUSTED: Clock = { offsetMs: 0, trusted: true };
const at = (iso: string) => Date.parse(iso);
const beach = (id: string, hidden = false) => ({ id, hidden });

function source(
  nowIso: string,
  overrides: Partial<ViewSource> = {},
  statuses: Record<string, unknown> = example.beaches,
): ViewSource {
  return {
    phase: "ready",
    statuses,
    live: true,
    clock: TRUSTED,
    nowMs: at(nowIso),
    ...overrides,
  };
}

// 예시 해변 하나를 복사해 일부만 바꿈
function withStatus(
  id: string,
  change: (status: BeachStatus) => void,
): Record<string, unknown> {
  const original = example.beaches[id];
  if (!original) throw new Error(`예시에 없는 해변: ${id}`);
  const status = structuredClone(original);
  change(status);
  return { ...example.beaches, [id]: status };
}

describe("게시된 분류를 그대로 씀", () => {
  it("특보 없음", () => {
    const view = deriveBeachView(
      beach("b0001"),
      source("2026-10-17T05:30:00Z"),
    );
    expect(view).toMatchObject({
      kind: "ready",
      category: "clear",
      badge: { kind: "clear" },
      confirmedAt: null,
    });
  });

  it("이용불가: 배지는 특보 이름", () => {
    const view = deriveBeachView(
      beach("b0002"),
      source("2026-10-17T05:30:00Z"),
    );
    expect(view).toMatchObject({
      category: "unavailable",
      badge: { kind: "warning", type: "wind_wave", level: "advisory" },
    });
  });

  it("판단불가: 배지는 관측 지연, 파고 값은 숨김", () => {
    const view = deriveBeachView(
      beach("b0003"),
      source("2026-10-17T05:30:00Z"),
    );
    expect(view).toMatchObject({
      category: "undetermined",
      badge: { kind: "observation_delayed" },
      metrics: { waveHeight: { kind: "hidden" }, wavePeriod: { kind: "none" } },
    });
  });

  it("측정소 없음은 '가까운 관측 없음' 자리만, 분류 영향 없음", () => {
    const view = deriveBeachView(
      beach("b0001"),
      source("2026-10-17T05:30:00Z"),
    );
    expect(view).toMatchObject({
      category: "clear",
      metrics: {
        waveHeight: { kind: "value", value: 0.6, unit: "m" },
        wavePeriod: { kind: "none" },
      },
    });
  });
});

describe("만료 경계 (아키텍처 14.1)", () => {
  // 파고 기준 90분: validUntil을 파고 expiresAt(observedAt 05:00 + 90분)에 맞춤
  const waveBound = withStatus("b0001", (status) => {
    status.validUntil = "2026-10-17T06:30:00Z";
  });

  it.each([
    ["89:59", "2026-10-17T06:29:59Z", "clear", "value"],
    ["90:00", "2026-10-17T06:30:00Z", "clear", "value"],
    ["90:01", "2026-10-17T06:30:01Z", "undetermined", "hidden"],
  ])("파고 %s (%s) → %s, 파고 값 %s", (_, now, category, waveHeight) => {
    const view = deriveBeachView(beach("b0001"), source(now, {}, waveBound));
    expect(view).toMatchObject({
      category,
      metrics: { waveHeight: { kind: waveHeight } },
    });
  });

  it("validUntil이 지나면 즉시 판단불가(특보 확인 못 함)", () => {
    const view = deriveBeachView(
      beach("b0001"),
      source("2026-10-17T06:03:41Z"),
    );
    expect(view).toMatchObject({
      category: "undetermined",
      badge: { kind: "warning_unknown" },
    });
  });

  // 파주기 기준 60분(B4): 값만 숨기고 분류는 그대로
  const periodBound = withStatus("b0001", (status) => {
    status.validUntil = "2026-10-17T07:00:00Z";
    status.observation.metrics.wavePeriod = {
      value: 6,
      unit: "s",
      observedAt: "2026-10-17T05:20:00Z",
      state: "fresh",
      nextExpectedAt: "2026-10-17T05:50:00Z",
      expiresAt: "2026-10-17T06:20:00Z",
    };
  });

  it.each([
    ["59:59", "2026-10-17T06:19:59Z", "value"],
    ["60:00", "2026-10-17T06:20:00Z", "value"],
    ["60:01", "2026-10-17T06:20:01Z", "hidden"],
  ])(
    "파주기 %s (%s) → 값 %s, 분류는 특보 없음 그대로",
    (_, now, wavePeriod) => {
      const view = deriveBeachView(
        beach("b0001"),
        source(now, {}, periodBound),
      );
      expect(view).toMatchObject({
        category: "clear",
        badge: { kind: "clear" },
        metrics: { wavePeriod: { kind: wavePeriod } },
      });
    },
  );

  it("수온·바람 delayed는 값만 숨김(B4)", () => {
    const statuses = withStatus("b0001", (status) => {
      status.observation.metrics.waterTemp.state = "delayed";
      status.observation.metrics.wind.state = "delayed";
    });
    const view = deriveBeachView(
      beach("b0001"),
      source("2026-10-17T05:30:00Z", {}, statuses),
    );
    expect(view).toMatchObject({
      category: "clear",
      metrics: {
        waveHeight: { kind: "value" },
        waterTemp: { kind: "hidden" },
        wind: { kind: "hidden" },
      },
    });
  });
});

describe("시계 보정 (9.1)", () => {
  const serverNow = "2026-10-17T05:30:00Z";
  // 기기 시계가 ±20분 어긋남. 보정된 시각 = 기기 시각 + offset
  it.each([
    ["20분 빠름", +20],
    ["20분 느림", -20],
  ])("기기 시계 %s: 보정하면 서버 시각 기준으로 판단", (_, minutes) => {
    const deviceNow = at(serverNow) + minutes * 60_000;
    const clock = clockFromHeaders(
      new Date(at(serverNow)).toUTCString(),
      null,
      deviceNow,
    );
    const view = deriveBeachView(beach("b0001"), {
      ...source(serverNow),
      clock,
      nowMs: deviceNow + clock.offsetMs,
    });
    expect(clock.offsetMs).toBe(-minutes * 60_000);
    expect(view).toMatchObject({ category: "clear" });
  });

  it("보정이 없으면 20분 빠른 시계는 유효한 정보를 만료로 봄(보정이 필요한 이유)", () => {
    const view = deriveBeachView(
      beach("b0001"),
      source(
        "2026-10-17T05:50:00Z",
        {},
        withStatus("b0001", (status) => {
          status.validUntil = "2026-10-17T05:45:00Z";
        }),
      ),
    );
    expect(view).toMatchObject({ category: "undetermined" });
  });

  // 서버 시각이 없으면 만료까지 5분 이내인 정보는 판단불가
  it.each([
    ["5분 1초 남음", "2026-10-17T05:58:39Z", "clear"],
    ["5분 남음", "2026-10-17T05:58:40Z", "undetermined"],
  ])("서버 시각 없음, validUntil까지 %s → %s", (_, now, category) => {
    const view = deriveBeachView(
      beach("b0001"),
      source(now, { clock: DEVICE_CLOCK }),
    );
    expect(view).toMatchObject({ category });
  });

  it("서버 시각 없음이어도 발효 중 특보는 이름 배지 유지", () => {
    const view = deriveBeachView(
      beach("b0002"),
      source("2026-10-17T06:00:00Z", { clock: DEVICE_CLOCK }),
    );
    expect(view).toMatchObject({
      category: "unavailable",
      badge: { kind: "warning", type: "wind_wave" },
      confirmedAt: "2026-10-17T05:18:40Z",
    });
  });

  it("서버 시각 없음: 만료 5분 이내 지표 값은 숨김", () => {
    const view = deriveBeachView(
      beach("b0001"),
      source(
        "2026-10-17T06:25:00Z",
        { clock: DEVICE_CLOCK },
        withStatus("b0001", (status) => {
          status.validUntil = "2026-10-17T07:00:00Z";
        }),
      ),
    );
    expect(view).toMatchObject({ metrics: { waveHeight: { kind: "hidden" } } });
  });
});

describe("오프라인·만료·장애 (B5)", () => {
  const offline = { live: false };

  it("발효 중 특보는 이름 배지 + 마지막 확인 시각 유지", () => {
    const view = deriveBeachView(
      beach("b0002"),
      source("2026-10-17T05:30:00Z", offline),
    );
    expect(view).toMatchObject({
      category: "unavailable",
      badge: { kind: "warning", type: "wind_wave", level: "advisory" },
      confirmedAt: "2026-10-17T05:18:40Z",
    });
  });

  it("validUntil이 지나도 발효 중 특보는 유지", () => {
    const view = deriveBeachView(
      beach("b0002"),
      source("2026-10-17T09:00:00Z"),
    );
    expect(view).toMatchObject({
      category: "unavailable",
      badge: { kind: "warning", type: "wind_wave", level: "advisory" },
      confirmedAt: "2026-10-17T05:18:40Z",
    });
  });

  it("'특보 없음'이던 해변은 특보 확인 못 함", () => {
    const view = deriveBeachView(
      beach("b0001"),
      source("2026-10-17T05:30:00Z", offline),
    );
    expect(view).toMatchObject({
      category: "undetermined",
      badge: { kind: "warning_unknown" },
    });
  });

  it("측정값은 지표별 만료 전이면 계속 보여줌", () => {
    const view = deriveBeachView(
      beach("b0001"),
      source("2026-10-17T05:30:00Z", offline),
    );
    expect(view).toMatchObject({ metrics: { waveHeight: { kind: "value" } } });
  });
});

describe("근거가 빠지거나 모순된 '특보 없음'은 판단불가", () => {
  it.each([
    ["특보 상태 없음", (s: Record<string, unknown>) => delete s.warning],
    [
      "사유가 있음",
      (s: Record<string, unknown>) => {
        s.reasons = [
          { code: "warning_unknown", scope: "x", source: "기상청", at: null },
        ];
      },
    ],
    ["사유 목록 없음", (s: Record<string, unknown>) => delete s.reasons],
    [
      "특보 state가 none이 아님",
      (s: BeachStatus) => {
        s.warning.state = "active";
      },
    ],
    [
      "특보 항목이 있음",
      (s: BeachStatus) => {
        s.warning.items = [
          {
            type: "wind_wave",
            level: "advisory",
            zoneCode: "S1",
            zoneName: "x",
            publishedAt: "2026-10-17T04:00:00Z",
            effectiveFrom: "2026-10-17T04:00:00Z",
          },
        ];
      },
    ],
    [
      "출처 없음",
      (s: BeachStatus) => {
        s.warning.source = "";
      },
    ],
    [
      "확인 시각 없음",
      (s: BeachStatus) => {
        s.warning.lastConfirmedAt = null;
      },
    ],
    [
      "파고 delayed",
      (s: BeachStatus) => {
        s.observation.metrics.waveHeight.state = "delayed";
      },
    ],
    [
      "파고 항목 없음",
      (s: Record<string, unknown>) => {
        s.observation = { metrics: {} };
      },
    ],
  ])("%s", (_, change) => {
    const statuses = withStatus("b0001", (status) =>
      (change as (s: BeachStatus) => void)(status),
    );
    const view = deriveBeachView(
      beach("b0001"),
      source("2026-10-17T05:30:00Z", {}, statuses),
    );
    expect(view).toMatchObject({
      category: "undetermined",
      badge: { kind: "unconfirmed" },
    });
  });

  it("이용불가는 근거가 일부 빠져도 이용불가 유지(위험 정보는 사라지지 않음)", () => {
    const statuses = withStatus("b0002", (status) => {
      delete (status as Partial<BeachStatus>).warning;
    });
    const view = deriveBeachView(
      beach("b0002"),
      source("2026-10-17T05:30:00Z", {}, statuses),
    );
    expect(view).toMatchObject({ category: "unavailable" });
  });
});

describe("모르는 데이터 (9.1)", () => {
  it("모르는 사유 code + 이용불가 → 분류 유지, 이름은 '이용 제한'", () => {
    const statuses = withStatus("b0002", (status) => {
      (status.reasons[0] as { code: string }).code = "control_closed";
    });
    const view = deriveBeachView(
      beach("b0002"),
      source("2026-10-17T05:30:00Z", {}, statuses),
    );
    expect(view).toMatchObject({
      category: "unavailable",
      badge: { kind: "restricted" },
    });
  });

  it("모르는 사유 code + 판단불가 → 분류 유지, 이름은 '확인 못 함'", () => {
    const statuses = withStatus("b0003", (status) => {
      (status.reasons[0] as { code: string }).code = "new_source_failed";
    });
    const view = deriveBeachView(
      beach("b0003"),
      source("2026-10-17T05:30:00Z", {}, statuses),
    );
    expect(view).toMatchObject({
      category: "undetermined",
      badge: { kind: "unconfirmed" },
    });
  });

  it("모르는 특보 종류는 이름을 지어내지 않음", () => {
    const statuses = withStatus("b0002", (status) => {
      (status.reasons[0] as { type: string }).type = "volcano";
    });
    const view = deriveBeachView(
      beach("b0002"),
      source("2026-10-17T05:30:00Z", {}, statuses),
    );
    expect(view).toMatchObject({
      category: "unavailable",
      badge: { kind: "restricted" },
    });
  });

  it("모르는 category → 판단불가", () => {
    const statuses = withStatus("b0001", (status) => {
      (status as { category: string }).category = "caution";
    });
    const view = deriveBeachView(
      beach("b0001"),
      source("2026-10-17T05:30:00Z", {}, statuses),
    );
    expect(view).toMatchObject({
      category: "undetermined",
      badge: { kind: "unconfirmed" },
    });
  });

  it("status에 없는 해변 → 판단불가(숨기지 않음)", () => {
    const view = deriveBeachView(
      beach("b9999"),
      source("2026-10-17T05:30:00Z"),
    );
    expect(view).toMatchObject({
      kind: "ready",
      category: "undetermined",
      badge: { kind: "unconfirmed" },
    });
  });

  it("노출 끔 표시가 있을 때만 숨김", () => {
    expect(
      deriveBeachView(beach("b9999", true), source("2026-10-17T05:30:00Z")),
    ).toEqual({ kind: "hidden" });
    expect(
      deriveBeachView(beach("b0001", true), source("2026-10-17T05:30:00Z")),
    ).toEqual({ kind: "hidden" });
  });

  it("지원 범위 밖 schemaVersion → 모든 해변 판단불가", () => {
    for (const id of ["b0001", "b0002", "b0003"]) {
      const view = deriveBeachView(
        beach(id),
        source("2026-10-17T05:30:00Z", { phase: "schema_unsupported" }),
      );
      expect(view).toMatchObject({
        category: "undetermined",
        badge: { kind: "unconfirmed" },
      });
    }
  });

  it("아직 못 받음 → loading", () => {
    expect(
      deriveBeachView(
        beach("b0001"),
        source("2026-10-17T05:30:00Z", { phase: "loading", statuses: null }),
      ),
    ).toEqual({ kind: "loading" });
  });
});
