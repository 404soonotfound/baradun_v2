import { beforeEach, describe, expect, it, vi } from "vitest";

// 노출 끈 해변·없는 slug (아키텍처 9장, BRD-45): 상세 경로를 만들지 않고 찾지도 않음 → 404
// data/beaches 대신 가짜 파일 목록을 읽게 함(node:fs를 바꿔 끼움)
const files = vi.hoisted(() => new Map<string, string>());

vi.mock("node:fs", () => ({
  existsSync: () => true,
  readdirSync: () => [...files.keys()],
  readFileSync: (file: string) => {
    const name = file.split("/").at(-1) ?? "";
    const text = files.get(name);
    if (text === undefined) throw new Error(`없는 파일: ${file}`);
    return text;
  },
}));

const { beachSlugParams, findBeach, listAltCandidates } =
  await import("./beaches");

function beach(id: string, slug: string, hidden: boolean, lat = 37.8) {
  return JSON.stringify({
    id,
    slug,
    hidden,
    coords: { lat, lng: 128.9 },
    name: { ko: slug, en: slug },
    region: {
      sido: { ko: "강원", en: "Gangwon" },
      sigungu: { ko: "강릉시", en: "Gangneung" },
    },
    activities: ["swimming"],
    stations: {},
  });
}

beforeEach(() => {
  files.clear();
  files.set("b0001.json", beach("b0001", "gangmun", false));
  files.set("b0002.json", beach("b0002", "closed-beach", true, 37.81));
  files.set("b0003.json", beach("b0003", "gyeongpo", false, 37.81));
  files.set("README.md", "# 읽지 않음");
});

describe("노출 끈 해변", () => {
  it("상세 경로를 만들지 않음", () => {
    expect(beachSlugParams()).toEqual([
      { slug: "gangmun" },
      { slug: "gyeongpo" },
    ]);
  });

  it("slug로 찾지 않음(페이지가 notFound)", () => {
    expect(findBeach("closed-beach")).toBeNull();
    expect(findBeach("gangmun")?.beach.id).toBe("b0001");
  });

  it("대안 해변 후보에도 넣지 않음", () => {
    const here = { id: "b0001", coords: { lat: 37.8, lng: 128.9 } };
    expect(listAltCandidates(here, "ko").map((item) => item.id)).toEqual([
      "b0003",
    ]);
  });
});

describe("없는 slug", () => {
  it("찾지 않음", () => {
    expect(findBeach("no-such-beach")).toBeNull();
  });

  it("공개 해변이 하나도 없으면 자리 slug 하나만(그 페이지도 404)", () => {
    files.delete("b0001.json");
    files.delete("b0003.json");
    expect(beachSlugParams()).toEqual([{ slug: "_" }]);
    expect(findBeach("_")).toBeNull();
  });
});
