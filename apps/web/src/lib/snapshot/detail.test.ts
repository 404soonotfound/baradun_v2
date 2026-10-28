import { readFileSync } from "node:fs";

import type { BeachStatus, StatusFile } from "@baradun/contracts";
import { describe, expect, it } from "vitest";

import type { Clock } from "./clock";
import { deriveDetail, warningCheckState, warningSourceOf } from "./detail";
import { deriveBeachView, type ViewSource } from "./view";

// 장소 상세 값 꺼내기 (BRD-32). 입력은 계약 예시 데이터
// 예시: b0001 특보 없음(운영 기간 아님) · b0094 풍랑주의보 · b0272 관측 지연
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
const NOW = "2026-10-17T05:30:00Z";

function source(
  overrides: Partial<ViewSource> = {},
  statuses: Record<string, unknown> = example.beaches,
): ViewSource {
  return {
    phase: "ready",
    statuses,
    live: true,
    clock: TRUSTED,
    nowMs: Date.parse(NOW),
    ...overrides,
  };
}

function withStatus(id: string, change: (status: BeachStatus) => void) {
  const status = structuredClone(example.beaches[id]!);
  change(status);
  return { ...example.beaches, [id]: status };
}

// 계약 예시의 b0001에는 주변 특보가 없어 테스트에서 하나를 넣음.
const NEARBY = {
  type: "dry",
  level: "advisory",
  zoneCode: "L1022510",
  zoneName: "강릉시평지",
  publishedAt: "2026-10-17T01:00:00Z",
  effectiveFrom: "2026-10-17T01:00:00Z",
};

function withNearby(change: Partial<typeof NEARBY>) {
  return withStatus("b0001", (status) => {
    (status.info as { nearbyWarnings: unknown }).nearbyWarnings = [
      { ...NEARBY, ...change },
    ];
  });
}

function detailOf(id: string, src: ViewSource) {
  const view = deriveBeachView({ id, hidden: false }, src);
  return { view, detail: deriveDetail(id, view, src) };
}

describe("deriveDetail", () => {
  it("이용불가: 발효 특보 항목과 사유 근거", () => {
    const { detail } = detailOf("b0094", source());
    expect(detail.warnings).toHaveLength(1);
    expect(detail.warnings[0]).toMatchObject({
      type: "wind_wave",
      level: "advisory",
    });
    expect(detail.basis).toEqual([
      {
        code: "warning",
        scope: "부산앞바다",
        source: "기상청",
        at: "2026-10-17T04:00:00Z",
      },
    ]);
    expect(detail.warningConfirmedNone).toBe(false);
  });

  it("오프라인(B5): 발효 특보 항목은 유지, 근거는 비움('이후 확인 못 함'만)", () => {
    const { view, detail } = detailOf("b0094", source({ live: false }));
    expect(view).toMatchObject({ category: "unavailable", stale: true });
    expect(detail.warnings).toHaveLength(1);
    expect(detail.basis).toEqual([]);
  });

  it("특보 없음: 특보 칸은 '없음', 사유 근거는 없음", () => {
    const { detail } = detailOf("b0001", source());
    expect(detail.warnings).toEqual([]);
    expect(detail.basis).toEqual([]);
    expect(detail.warningConfirmedNone).toBe(true);
    expect(detail.warningSource).toBe("기상청");
  });

  it("'특보 없음'이던 해변이 오프라인이면 특보 칸은 '확인 못 함'", () => {
    const { detail } = detailOf("b0001", source({ live: false }));
    expect(detail.warningConfirmedNone).toBe(false);
  });

  it("특보 확인 못 함 사유가 있으면 특보 칸은 '없음'이 아님", () => {
    const statuses = withStatus("b0001", (status) => {
      status.category = "undetermined";
      status.reasons = [
        {
          code: "warning_unknown",
          scope: "강원북부앞바다",
          source: "기상청",
          at: status.warning.lastConfirmedAt,
        },
      ];
    });
    const { detail } = detailOf("b0001", source({}, statuses));
    expect(detail.warningConfirmedNone).toBe(false);
    expect(detail.basis[0]).toMatchObject({ code: "warning_unknown" });
  });

  it("특보 확인이 45분 넘게 지났으면 특보 칸은 '없음'이 아님", () => {
    const { detail } = detailOf(
      "b0272",
      source({ nowMs: Date.parse("2026-10-17T06:04:00Z") }),
    );
    expect(detail.warningConfirmedNone).toBe(false);
  });

  it("운영 기간 밖이면 정보 배지, 일정이 없으면(null) 숨김", () => {
    expect(detailOf("b0001", source()).detail.offSeason).toEqual({
      openFrom: "2026-07-10",
      openUntil: "2026-08-20",
    });
    expect(detailOf("b0094", source()).detail.offSeason).toBeNull();
    const inSeason = withStatus("b0001", (status) => {
      status.info.season = {
        openFrom: "2026-07-10",
        openUntil: "2026-08-20",
        inSeason: true,
      };
    });
    expect(detailOf("b0001", source({}, inSeason)).detail.offSeason).toBeNull();
  });

  it("주변 특보: 모르는 종류도 숨기지 않고 일반 단어로", () => {
    const statuses = withNearby({ type: "new_kind" });
    const { detail } = detailOf("b0001", source({}, statuses));
    expect(detail.nearbyWarnings).toHaveLength(1);
    expect(detail.nearbyWarnings[0]?.type).toBeNull();
  });

  it("모르는 사유 code의 판단불가는 특보 칸이 '없음'이 아님(관측 지연만일 때만 '없음')", () => {
    expect(detailOf("b0272", source()).detail.warningConfirmedNone).toBe(true);
    const statuses = withStatus("b0272", (status) => {
      (status.reasons[0] as { code: string }).code = "new_reason";
    });
    const { detail } = detailOf("b0272", source({}, statuses));
    expect(detail.warningConfirmedNone).toBe(false);
  });

  it("읽을 수 없는 발효 특보 항목은 버리지 않고 개수로 남김", () => {
    const statuses = withStatus("b0094", (status) => {
      (status.warning.items[0] as { type: string }).type = "new_kind";
    });
    const { view, detail } = detailOf("b0094", source({}, statuses));
    // 분류·배지는 게시값 그대로(이용불가·풍랑주의보 사유). 읽지 못한 항목 때문에 낮추지 않음
    expect(view).toMatchObject({
      category: "unavailable",
      badge: { kind: "warning", type: "wind_wave" },
    });
    expect(detail.warnings).toEqual([]);
    expect(detail.unreadableWarnings).toBe(1);
  });

  it("발효 특보 목록 자체를 읽을 수 없으면 읽지 못한 항목으로 남김(사유 상자가 비지 않게)", () => {
    const statuses = withStatus("b0094", (status) => {
      (status.warning as { items: unknown }).items = null;
    });
    const { detail } = detailOf("b0094", source({}, statuses));
    expect(detail.warnings).toEqual([]);
    expect(detail.unreadableWarnings).toBe(1);
  });

  it("warningSourceOf: 기관만 꺼냄, 읽을 수 없으면 null", () => {
    expect(warningSourceOf("b0001", source())).toBe("기상청");
    expect(warningSourceOf("missing", source())).toBeNull();
    const statuses = withStatus("b0001", (status) => {
      (status.warning as { source: unknown }).source = "";
    });
    expect(warningSourceOf("b0001", source({}, statuses))).toBeNull();
  });

  it("이안류: 게시된 null은 제공 기간 아님, 읽을 수 없거나 상태가 없으면 unknown", () => {
    const off = withStatus("b0001", (status) => {
      status.info.ripCurrent = null;
    });
    expect(detailOf("b0001", source({}, off)).detail.ripCurrent).toBeNull();
    const broken = withStatus("b0001", (status) => {
      (status.info as { ripCurrent: unknown }).ripCurrent = { label: "" };
    });
    expect(detailOf("b0001", source({}, broken)).detail.ripCurrent).toBe(
      "unknown",
    );
    const missing = detailOf("b9999", source()).detail;
    expect(missing.ripCurrent).toBe("unknown");
  });

  it("읽을 수 없는 주변 특보는 버리지 않고 개수로 남김(Codex P1)", () => {
    const statuses = withNearby({ level: "new_level" });
    const { detail } = detailOf("b0001", source({}, statuses));
    expect(detail.nearbyWarnings).toEqual([]);
    expect(detail.unreadableNearby).toBe(1);
  });

  it("주변 특보 목록 자체를 읽을 수 없으면 'all'(빈 목록으로 보지 않음)", () => {
    const statuses = withStatus("b0001", (status) => {
      (status.info as { nearbyWarnings: unknown }).nearbyWarnings = null;
    });
    expect(
      detailOf("b0001", source({}, statuses)).detail.unreadableNearby,
    ).toBe("all");
    expect(detailOf("b0001", source()).detail.unreadableNearby).toBe(0);
  });

  it("점검 중이면 아무것도 꺼내지 않음", () => {
    const { detail } = detailOf("b0094", source({ phase: "maintenance" }));
    expect(detail.warnings).toEqual([]);
    expect(detail.offSeason).toBeNull();
  });
});

describe("지표 값 자리 구분 (B4)", () => {
  it("모르는 state는 늦어짐이 아니라 '–'(hidden)", () => {
    const statuses = withStatus("b0001", (status) => {
      (status.observation.metrics.wind as { state: string }).state = "stale";
    });
    const { view } = detailOf("b0001", source({}, statuses));
    expect(view).toMatchObject({ metrics: { wind: { kind: "hidden" } } });
  });
});

// '확인한 것' 특보 칸 (판단 카드 ⑤ · '자세히' 시트가 함께 씀, BRD-33)
describe("warningCheckState", () => {
  function stateOf(id: string, src: ViewSource) {
    const { view, detail } = detailOf(id, src);
    if (view.kind !== "ready") throw new Error("ready가 아님");
    return warningCheckState(view, detail);
  }

  it("특보 발효 → 발효 중, 관측 지연만 → 없음", () => {
    expect(stateOf("b0094", source())).toBe("active");
    expect(stateOf("b0272", source())).toBe("none");
  });

  it("모르는 사유만 있는 이용불가('이용 제한')는 발효 중이라고 지어내지 않음", () => {
    const statuses = withStatus("b0094", (status) => {
      (status.reasons[0] as { code: string }).code = "new_reason";
      status.warning.items = [];
    });
    expect(stateOf("b0094", source({}, statuses))).toBe("unknown");
  });
});
