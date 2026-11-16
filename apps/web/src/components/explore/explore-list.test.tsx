import { NextIntlClientProvider } from "next-intl";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import ko from "../../../messages/ko.json";
import { BeachListRow } from "@/components/beach-row";
import { MapCard } from "@/components/map/map-card";
import type { ExploreItem } from "@/lib/explore";
import { useRowText } from "@/lib/snapshot/use-row-text";
import type { BeachView, MetricView } from "@/lib/snapshot/view";

import { ExploreSummary } from "./explore-summary";

// 탐색 시안 C(GH-529 · 결정 기록 29장 D29-2·D29-6): 세 줄 목록 줄 문구와 요약 한 줄

const NOW = Date.parse("2026-11-16T08:30:00Z");
const AT = "2026-11-16T08:10:00Z"; // 20분 전
const value = (v: number, unit: "m" | "s" | "°C" | "m/s"): MetricView => ({
  kind: "value",
  value: v,
  unit,
  observedAt: AT,
});
type Ready = Extract<BeachView, { kind: "ready" }>;
const METRICS: Ready["metrics"] = {
  waveHeight: value(0.6, "m"),
  wavePeriod: value(6.2, "s"),
  waveDirection: { kind: "none" },
  waterTemp: value(21.4, "°C"),
  wind: value(3.1, "m/s"),
};
const CLEAR: Ready = {
  kind: "ready",
  category: "clear",
  badge: { kind: "clear" },
  reasons: [{ kind: "clear" }],
  stale: false,
  confirmedAt: "2026-11-16T08:01:00Z",
  metrics: METRICS,
};
const withTemp = (waterTemp: MetricView): Ready => ({
  ...CLEAR,
  metrics: { ...METRICS, waterTemp },
});

function html(node: ReactNode) {
  return renderToStaticMarkup(
    <NextIntlClientProvider locale="ko" messages={ko} timeZone="Asia/Seoul">
      {node}
    </NextIntlClientProvider>,
  );
}
// 훅(useRowText)이 만든 문구를 글자로 꺼냄
function Lines({ view, km }: { view: BeachView; km: number | null }) {
  const { listMeta, listNote } = useRowText();
  return (
    <>
      <p>{listMeta("강원 강릉시", km, view, NOW)}</p>
      <p>{listNote(view, NOW) ?? "(없음)"}</p>
    </>
  );
}
const lines = (view: BeachView, km: number | null = 6.2) =>
  html(<Lines view={view} km={km} />);

describe("세 줄 목록 줄 문구", () => {
  it("2줄째: 지역 · 거리 · 수온 · 수온 측정 시각", () => {
    expect(lines(CLEAR)).toContain(
      "<p>강원 강릉시 · 6.2km · 수온 21.4°C · 20분 전 측정</p>",
    );
  });
  it("위치가 없으면 거리 없이", () => {
    expect(lines(CLEAR, null)).toContain(
      "<p>강원 강릉시 · 수온 21.4°C · 20분 전 측정</p>",
    );
  });
  it("측정기가 없으면 '가까운 관측 없음'(0·정상으로 보이지 않음)", () => {
    expect(lines(withTemp({ kind: "none" }))).toContain(
      "<p>강원 강릉시 · 6.2km · 가까운 관측 없음</p>",
    );
  });
  it("수온이 늦어지면 값 없이 지연이라고 알림", () => {
    const out = lines(withTemp({ kind: "delayed" }));
    expect(out).toContain(
      "<p>강원 강릉시 · 6.2km · 수온 · 측정이 늦어지고 있어요</p>",
    );
    expect(out).not.toContain("°C");
  });
  it("일시 결측이면 수온 자리를 비움(값·시각 없음)", () => {
    expect(lines(withTemp({ kind: "hidden" }))).toContain(
      "<p>강원 강릉시 · 6.2km</p>",
    );
  });
  it("특보 없음은 넷째 줄 없음(구역·기관·확인 시각은 묶음 머리에 한 번)", () => {
    expect(lines(CLEAR)).toContain("<p>(없음)</p>");
  });
  it("관측 지연은 넷째 줄에 파고 지연 + 파주기", () => {
    const delayed: Ready = {
      ...CLEAR,
      category: "undetermined",
      badge: { kind: "observation_delayed" },
      reasons: [{ kind: "observation_delayed" }],
      metrics: { ...METRICS, waveHeight: { kind: "delayed" } },
    };
    expect(lines(delayed)).toContain(
      "<p>파고 · 측정이 늦어지고 있어요 · 파주기 6.2s</p>",
    );
  });
  it("판단불가에서 파고 값을 보이면 그 값의 측정 시각을 바로 뒤에 붙임", () => {
    // 2줄째 'n분 전 측정'은 수온의 시각이라, 시각이 다른 파고 값이 수온 시각으로 읽히지 않게 함
    const unknown: Ready = {
      ...CLEAR,
      category: "undetermined",
      badge: { kind: "warning_unknown" },
      reasons: [{ kind: "warning_unknown" }],
      metrics: {
        ...METRICS,
        waveHeight: {
          kind: "value",
          value: 0.6,
          unit: "m",
          observedAt: "2026-11-16T07:20:00Z", // 70분 전
        },
      },
    };
    const out = lines(unknown);
    expect(out).toContain(
      "<p>강원 강릉시 · 6.2km · 수온 21.4°C · 20분 전 측정</p>",
    );
    expect(out).toContain("<p>파고 0.6m · 70분 전 측정 · 파주기 6.2s</p>");
  });
  it("오래된 정보는 'HH:MM 확인 · 이후 확인 못 함'을 남김", () => {
    const stale: Ready = {
      ...CLEAR,
      category: "undetermined",
      badge: { kind: "warning_unknown" },
      reasons: [{ kind: "warning_unknown" }],
      stale: true,
    };
    expect(lines(stale)).toContain("17:01 확인 · 이후 확인 못 함");
  });
  it("오래된 이용불가는 확인 시각 뒤에 남은 특보도 그대로 둠", () => {
    const staleBlocked: Ready = {
      ...CLEAR,
      category: "unavailable",
      badge: { kind: "warning", type: "wind_wave", level: "advisory" },
      reasons: [
        { kind: "warning", type: "wind_wave", level: "advisory" },
        { kind: "warning", type: "strong_wind", level: "advisory" },
      ],
      stale: true,
    };
    expect(lines(staleBlocked)).toContain(
      "<p>17:01 확인 · 이후 확인 못 함 · 강풍주의보</p>",
    );
  });
  it("이용불가는 칩 뒤에 남은 사유만(파고 값 없음)", () => {
    const blocked: Ready = {
      ...CLEAR,
      category: "unavailable",
      badge: { kind: "warning", type: "wind_wave", level: "advisory" },
      reasons: [
        { kind: "warning", type: "wind_wave", level: "advisory" },
        { kind: "warning", type: "strong_wind", level: "advisory" },
      ],
    };
    const out = lines(blocked);
    expect(out).toContain("<p>강풍주의보</p>");
    expect(out).not.toContain("파고");
  });
});

describe("BeachListRow", () => {
  it("해변명 + 상태 칩(사유 먼저) + 세 줄, 파고 칸 없음", () => {
    const out = html(
      <BeachListRow
        href="/spots/gyeongpo/"
        name="경포해수욕장"
        badge={{ kind: "observation_delayed" }}
        meta="강원 강릉시 · 6.5km · 수온 21.4°C · 20분 전 측정"
        activities="확인된 활동 수영 · 서핑"
        note={null}
      />,
    );
    expect(out).toContain("경포해수욕장");
    expect(out).toContain("관측 지연");
    expect(out).toContain("확인된 활동 수영 · 서핑");
    expect(out).not.toContain("판단불가");
    expect(out).not.toContain("파고");
  });
});

describe("MapCard", () => {
  // 근거 줄 문구만 봄. 줄에 쓰지 않는 칸(좌표·측정소 등)은 비워 둠
  const item = (view: BeachView) =>
    ({
      id: "gyeongpo",
      slug: "gyeongpo",
      name: "경포해수욕장",
      region: "강원 강릉시",
      warningZones: [],
      photo: null,
      distanceKm: null,
      view,
    }) as unknown as ExploreItem;
  const card = (view: BeachView) =>
    html(
      <MapCard locale="ko" item={item(view)} nowMs={NOW} onClose={() => {}} />,
    );

  it("오래된 이용불가는 확인 시각과 함께 남은 특보도 보임(둘째 특보를 가리지 않음)", () => {
    const out = card({
      ...CLEAR,
      category: "unavailable",
      badge: { kind: "warning", type: "wind_wave", level: "advisory" },
      reasons: [
        { kind: "warning", type: "wind_wave", level: "advisory" },
        { kind: "warning", type: "strong_wind", level: "advisory" },
      ],
      stale: true,
    });
    expect(out).toContain("풍랑주의보");
    expect(out).toContain(
      "강원 강릉시 · 17:01 확인 · 이후 확인 못 함 · 강풍주의보",
    );
  });
  it("오래된 정보 문구를 두 번 쓰지 않음", () => {
    const out = card({
      ...CLEAR,
      category: "undetermined",
      badge: { kind: "warning_unknown" },
      reasons: [{ kind: "warning_unknown" }],
      stale: true,
    });
    expect(out.split("이후 확인 못 함").length - 1).toBe(1);
  });
});

describe("ExploreSummary", () => {
  const counts = [
    { category: "clear", label: { kind: "clear" }, count: 17 },
    {
      category: "undetermined",
      label: { kind: "observation_delayed" },
      count: 2,
    },
  ] as const;
  const text = (node: ReactNode) =>
    html(node)
      .replace(/<svg[\s\S]*?<\/svg>/g, "")
      .replace(/<[^>]+>/g, "");
  it("전체 n곳 · 사유별 개수 · HH:MM 업데이트 + 새로고침", () => {
    const out = text(
      <ExploreSummary
        total={19}
        counts={counts}
        time="17:13"
        stale={null}
        nowMs={NOW}
        refreshing={false}
        onRefresh={() => {}}
      />,
    );
    expect(out).toBe(
      "전체 19곳·특보 없음 17·관측 지연 2·17:13 업데이트새로고침",
    );
  });
  it("오래된 정보가 섞이면 가장 이른 확인 시각 + '이후 확인 못 함'", () => {
    const out = text(
      <ExploreSummary
        total={19}
        counts={counts}
        time="17:13"
        stale={{ confirmedAt: "2026-11-16T08:01:00Z" }}
        nowMs={NOW}
        refreshing={false}
        onRefresh={() => {}}
      />,
    );
    expect(out).toContain("17:13 업데이트·17:01 확인 · 이후 확인 못 함");
  });
  it("불러오는 중에는 개수를 미리 보이지 않음", () => {
    const out = text(
      <ExploreSummary
        total={null}
        counts={[]}
        time={null}
        stale={null}
        nowMs={NOW}
        refreshing
        onRefresh={() => {}}
      />,
    );
    expect(out).toBe("새로고침");
  });
});
