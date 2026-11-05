import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  buildAreas,
  codeSets,
  codesDigest,
  landOf,
  midAreaOf,
  readPublicBeaches,
  toGrid,
} from "../weather-areas.mjs";

// 해변 → 날씨 예보 구역 대응표(data/weather-areas.json, BRD-181)
// 공개 해변이 모두 들어 있고, 지금 규칙으로 다시 만든 결과와 같아야 수집기·publisher가 그대로 씀

const data = new URL("../../../data/", import.meta.url);
const file = JSON.parse(
  readFileSync(new URL("weather-areas.json", data), "utf8"),
) as {
  _meta: {
    verified: {
      grids: number;
      midLand: number;
      midTa: number;
      codes: string;
    } | null;
  };
  beaches: Record<string, unknown>;
};
const zones = JSON.parse(
  readFileSync(new URL("../mid-zones.json", import.meta.url), "utf8"),
) as { ta: { regId: string; name: string }[] };

const beach = (sido: string, sigungu: string) => ({
  id: "b9999",
  region: { sido: { ko: sido }, sigungu: { ko: sigungu } },
});

describe("격자 변환", () => {
  it("기상청 격자와 같음: 경포 (93, 133)·서울 종로 (60, 127)", () => {
    expect(toGrid(37.803514, 128.909962)).toEqual({ nx: 93, ny: 133 });
    expect(toGrid(37.5729, 126.9794)).toEqual({ nx: 60, ny: 127 });
  });
});

describe("중기 구역", () => {
  it("시·군 이름과 같은 기온 지점을 고르고, 육상 구역은 그 지점 구역", () => {
    expect(midAreaOf(beach("강원", "강릉시"))).toEqual({
      midLand: { regId: "11D20000", name: "강원영동" },
      midTa: { regId: "11D20501", name: "강릉", rule: "sigungu" },
    });
  });

  it("광역시의 구·군은 광역시 지점: 인천 옹진군 → 인천, 부산 해운대구 → 부산", () => {
    expect(midAreaOf(beach("인천", "옹진군")).midTa).toEqual({
      regId: "11B20201",
      name: "인천",
      rule: "metro",
    });
    expect(midAreaOf(beach("부산", "해운대구")).midTa.regId).toBe("11H20201");
  });

  it("같은 이름이 두 시도에 있으면 시도로 가름: 강원 고성 · 경남 고성", () => {
    expect(midAreaOf(beach("강원", "고성군")).midTa.regId).toBe("11D20402");
    expect(midAreaOf(beach("경남", "고성군")).midTa.regId).toBe("11H20404");
  });

  it("서해안 21F 지점은 전북·전남 구역에 속함", () => {
    expect(landOf("21F10602")).toBe("11F10000");
    expect(landOf("21F20803")).toBe("11F20000");
  });

  it("맞는 지점이 없거나 모르는 시도면 멈춤(최근접으로 추측하지 않음)", () => {
    expect(() => midAreaOf(beach("경남", "없는군"))).toThrow(/0곳/);
    expect(() => midAreaOf(beach("독도", "울릉군"))).toThrow(/모르는 시도/);
  });

  it("섬 지점(백령도 11A·울릉도/독도 11E)만 육상 구역을 정하지 않음(코드표에 근거 없음)", () => {
    for (const t of zones.ta) {
      if (/^11[AE]/.test(t.regId))
        expect(() => landOf(t.regId), t.regId).toThrow();
      else expect(() => landOf(t.regId), t.regId).not.toThrow();
    }
  });
});

describe("data/weather-areas.json", () => {
  const areas = buildAreas(readPublicBeaches());

  it("공개 해변 206곳이 모두 있고 지금 규칙으로 만든 결과와 같음(바뀌면 weather-areas.mjs로 다시 생성)", () => {
    expect(Object.keys(areas)).toHaveLength(206);
    expect(file.beaches).toEqual(areas);
  });

  it("실호출 확인 기록이 지금 격자·구역·지점 묶음과 같음(대응이 바뀌면 --verify로 다시 확인)", () => {
    const sets = codeSets(areas);
    expect(file._meta.verified).toMatchObject({
      grids: sets.grids.length,
      midLand: sets.midLand.length,
      midTa: sets.midTa.length,
      codes: codesDigest(sets),
    });
  });
});
