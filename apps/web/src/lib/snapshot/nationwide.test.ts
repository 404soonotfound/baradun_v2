import type { NationwideWarningsFile, WarningItem } from "@baradun/contracts";
import { describe, expect, it } from "vitest";

import { nationwideView, readNationwide } from "./nationwide";

// 전국 해상 특보 (BRD-26)
const confirmed = "2026-10-17T05:18:40Z";
// 타입을 붙여야 "wind_wave"가 string이 아니라 WarningType으로 읽힘
const item: WarningItem = {
  type: "wind_wave",
  level: "advisory",
  zoneCode: "S1131200",
  zoneName: "동해중부먼바다",
  publishedAt: "2026-10-17T05:00:00Z",
  effectiveFrom: "2026-10-17T05:00:00Z",
};
const file: NationwideWarningsFile = {
  lastConfirmedAt: confirmed,
  items: [item],
};
const at = (iso: string) => Date.parse(iso);

describe("readNationwide", () => {
  it("계약 모양이면 그대로", () => {
    expect(readNationwide(file)).toEqual(file);
  });

  it("항목 하나라도 읽을 수 없으면 null", () => {
    expect(
      readNationwide({ ...file, items: [item, { ...item, type: "rain" }] }),
    ).toBeNull();
    expect(
      readNationwide({ ...file, items: [{ ...item, zoneName: "" }] }),
    ).toBeNull();
  });

  it("확인 시각이 깨졌으면 null, 없음(null)은 허용", () => {
    expect(readNationwide({ ...file, lastConfirmedAt: "어제" })).toBeNull();
    expect(readNationwide({ ...file, lastConfirmedAt: null })).not.toBeNull();
  });
});

describe("nationwideView", () => {
  const live = { live: true, nowMs: at("2026-10-17T05:30:00Z") };

  it("받기 전은 loading, 받지 못했으면 failed", () => {
    expect(nationwideView(null, false, live)).toEqual({ kind: "loading" });
    expect(nationwideView(null, true, live)).toEqual({ kind: "failed" });
  });

  it("45분 안이고 받는 중이면 stale 아님", () => {
    expect(nationwideView(file, false, live)).toMatchObject({
      kind: "ready",
      stale: false,
    });
  });

  it("45분이 지나거나 오프라인이거나 다시 받기 실패면 stale", () => {
    expect(
      nationwideView(file, false, {
        live: true,
        nowMs: at("2026-10-17T06:04:00Z"),
      }),
    ).toMatchObject({ stale: true });
    expect(nationwideView(file, false, { ...live, live: false })).toMatchObject(
      { stale: true },
    );
    expect(nationwideView(file, true, live)).toMatchObject({ stale: true });
  });

  it("확인 시각을 모르거나 지금 시각을 모르면 stale", () => {
    expect(
      nationwideView({ ...file, lastConfirmedAt: null }, false, live),
    ).toMatchObject({ stale: true });
    expect(
      nationwideView(file, false, { live: true, nowMs: Number.NaN }),
    ).toMatchObject({ stale: true });
  });
});
