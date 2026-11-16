import { describe, expect, it } from "vitest";

import {
  matchRange,
  matchRegions,
  normalize,
  searchBeaches,
  withParticle,
  withTopicParticle,
} from "@/lib/search";

function b(
  name: string,
  en: string,
  region: [string, string],
  aliases: string[] = [],
) {
  return {
    name,
    names: [name, en],
    aliases,
    regionNames: [`${region[0]} ${region[1]}`],
  };
}

const GYEONGPO = b(
  "경포해수욕장",
  "Gyeongpo Beach",
  ["강원", "강릉시"],
  ["경포대"],
);
const GANGMUN = b("강문해수욕장", "Gangmun Beach", ["강원", "강릉시"]);
const HAEUNDAE = b(
  "해운대해수욕장",
  "Haeundae Beach",
  ["부산", "해운대구"],
  ["해운대"],
);
const ALL = [HAEUNDAE, GANGMUN, GYEONGPO];

describe("searchBeaches", () => {
  it("한국어·영어 이름으로 찾고, 공백·대소문자는 무시", () => {
    expect(searchBeaches(ALL, "경포", "ko").map((h) => h.beach.name)).toEqual([
      "경포해수욕장",
    ]);
    expect(searchBeaches(ALL, "gyeongpo", "ko")).toHaveLength(1);
    expect(searchBeaches(ALL, " GYEONG PO ", "ko")).toHaveLength(1);
  });

  it("다른 이름(별칭)으로 찾으면 별칭 안내용 정보를 돌려줌", () => {
    const [hit] = searchBeaches(ALL, "경포대", "ko");
    expect(hit?.beach.name).toBe("경포해수욕장");
    expect(hit?.match).toEqual({ kind: "alias", alias: "경포대" });
  });

  it("별칭이 여럿 맞으면 가장 짧은 것을 안내에 씀", () => {
    const list = [
      b(
        "상맹방해수욕장",
        "Sangmaengbang",
        ["강원", "삼척시"],
        ["상맹방(승공)", "승공"],
      ),
    ];
    expect(searchBeaches(list, "승공", "ko")[0]?.match).toEqual({
      kind: "alias",
      alias: "승공",
    });
  });

  it("이름에도 맞으면 별칭 안내를 붙이지 않음", () => {
    const [hit] = searchBeaches(ALL, "해운대", "ko");
    expect(hit?.match).toEqual({ kind: "name" });
  });

  it("지역 이름으로도 찾음(이름 일치가 먼저, 지역 일치는 뒤)", () => {
    const hits = searchBeaches(ALL, "강릉", "ko");
    expect(hits.map((h) => h.beach.name)).toEqual([
      "강문해수욕장",
      "경포해수욕장",
    ]);
    expect(hits.every((h) => h.match.kind === "region")).toBe(true);
  });

  it("이름이 검색어로 시작하는 해변이 포함만 하는 해변보다 앞", () => {
    const list = [
      b("가경포해변", "Gakyeongpo", ["강원", "고성군"]),
      b("경포해변", "Gyeongpo", ["강원", "강릉시"]),
    ];
    expect(searchBeaches(list, "경포", "ko").map((h) => h.beach.name)).toEqual([
      "경포해변",
      "가경포해변",
    ]);
  });

  it("빈 검색어·공백뿐인 검색어·없는 이름은 결과 없음", () => {
    expect(searchBeaches(ALL, "", "ko")).toEqual([]);
    expect(searchBeaches(ALL, "   ", "ko")).toEqual([]);
    expect(searchBeaches(ALL, "없는해변", "ko")).toEqual([]);
  });

  it("노출을 끈 해변은 호출하는 쪽이 목록에서 뺀 상태라 별칭으로도 안 나옴", () => {
    const visible = ALL.filter((x) => x !== GYEONGPO);
    expect(searchBeaches(visible, "경포대", "ko")).toEqual([]);
  });
});

describe("matchRange · withTopicParticle · normalize", () => {
  it("일치한 부분의 위치(공백·대소문자 무시)", () => {
    expect(matchRange("경포해수욕장", "경포")).toEqual({ start: 0, end: 2 });
    expect(matchRange("Gyeongpo Beach", "po b")).toEqual({ start: 6, end: 10 });
    expect(matchRange("경포해수욕장", "없음")).toBeNull();
    expect(matchRange("경포해수욕장", "")).toBeNull();
  });

  it("조사는 받침으로 은/는", () => {
    expect(withTopicParticle("경포대")).toBe("경포대는");
    expect(withTopicParticle("송정해변")).toBe("송정해변은");
    expect(withTopicParticle("Gyeongpo")).toBe("Gyeongpo는");
    // 끝의 괄호는 건너뛰고 마지막 글자로 정함
    expect(withTopicParticle("상맹방(승공)")).toBe("상맹방(승공)은");
  });

  it("공백 제거·소문자·한글 조합 통일", () => {
    expect(normalize(" A b\tC ")).toBe("abc");
    expect(normalize("가")).toBe("가");
  });
});

// 검색 v5(GH-531): 결과 없음·결과 머리 문구의 조사, 입력 중 제안의 지역 줄
describe("withParticle", () => {
  it("으로/로: ㄹ 받침과 받침 없음은 '로'", () => {
    expect(withParticle("강원 양양군", "direction")).toBe("강원 양양군으로");
    expect(withParticle("강원 강릉시", "direction")).toBe("강원 강릉시로");
    expect(withParticle("제주 서귀포시", "direction")).toBe("제주 서귀포시로");
    expect(withParticle("강원 고성군(고성)", "direction")).toBe(
      "강원 고성군(고성)으로",
    );
  });
  it("과/와", () => {
    expect(withParticle("강원 양양군", "with")).toBe("강원 양양군과");
    expect(withParticle("강원 강릉시", "with")).toBe("강원 강릉시와");
  });
  it("은/는(주제)은 지금 규칙 그대로", () => {
    expect(withParticle("경포대", "topic")).toBe(withTopicParticle("경포대"));
    expect(withParticle("송정해변", "topic")).toBe("송정해변은");
  });
});

describe("matchRegions", () => {
  const r = (sido: string, sigungu: string, en: string) => ({
    sido: { key: sido, label: sido },
    sigungu: { key: sigungu, label: sigungu },
    region: `${sido} ${sigungu}`,
    regionNames: [`${sido} ${sigungu}`, en],
  });
  const YANGYANG_1 = r("강원", "양양군", "Gangwon Yangyang");
  const YANGYANG_2 = r("강원", "양양군", "Gangwon Yangyang");
  const GANGNEUNG = r("강원", "강릉시", "Gangwon Gangneung");
  it("검색어가 지역 이름에 든 시·군을 해변이 많은 순으로", () => {
    const found = matchRegions(
      [GANGNEUNG, YANGYANG_1, YANGYANG_2],
      "양양",
      "ko",
    );
    expect(found).toHaveLength(1);
    expect(found[0]?.label).toBe("강원 양양군");
    expect(found[0]?.beaches).toHaveLength(2);
    expect(
      matchRegions([GANGNEUNG, YANGYANG_1], "강원", "ko").map(
        (item) => item.label,
      ),
    ).toEqual(["강원 강릉시", "강원 양양군"]);
  });
  it("영어 지역 이름으로도, 빈 검색어는 없음", () => {
    expect(matchRegions([YANGYANG_1], "yangyang", "en")).toHaveLength(1);
    expect(matchRegions([YANGYANG_1], " ", "ko")).toEqual([]);
  });
});
