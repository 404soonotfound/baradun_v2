// slug 규칙 검사 (BRD-45): 통과해야 할 것과 막아야 할 것
import { describe, expect, it } from "vitest";
import { checkList, compareWithBase } from "../scripts/beach-rules.mjs";

const beach = (id: string, slug: string) => ({ id, slug });
const item = (id: string, slug: string, file = `${id}.json`) => ({
  file,
  beach: beach(id, slug),
});

describe("한 시점 규칙", () => {
  it("정상 목록은 통과", () => {
    expect(
      checkList([item("b0001", "gyeongpo"), item("b0002", "jinha-ulju")]),
    ).toEqual([]);
  });
  it("slug 중복은 실패", () => {
    expect(
      checkList([item("b0001", "gyeongpo"), item("b0002", "gyeongpo")]),
    ).toHaveLength(1);
  });
  it("id 중복은 실패", () => {
    expect(
      checkList([item("b0001", "a"), item("b0001", "b", "copy.json")]).length,
    ).toBeGreaterThan(0);
  });
  it("파일 이름이 id와 다르면 실패", () => {
    expect(
      checkList([item("b0001", "gyeongpo", "gyeongpo.json")]),
    ).toHaveLength(1);
  });
  it.each(["mangsang-haebyeon", "gyeongpo-haesuyokjang", "haean"])(
    "금지 단어 %s는 실패",
    (slug) => {
      expect(checkList([item("b0001", slug)])).toHaveLength(1);
    },
  );
  it("금지 단어가 다른 단어 안에 있으면 통과 (예: haeansa는 조각이 다름)", () => {
    expect(checkList([item("b0001", "haeansa")])).toEqual([]);
  });
});

describe("main과 비교", () => {
  const base = [beach("b0001", "gyeongpo"), beach("b0002", "sokcho")];

  it("그대로 두고 새 해변 추가는 통과", () => {
    expect(compareWithBase(base, [...base, beach("b0003", "naksan")])).toEqual(
      [],
    );
  });
  it("slug 변경은 실패", () => {
    expect(
      compareWithBase(base, [
        beach("b0001", "gyeongpo-gangneung"),
        beach("b0002", "sokcho"),
      ]),
    ).toHaveLength(1);
  });
  it("해변 삭제는 실패 (숨기려면 hidden)", () => {
    expect(compareWithBase(base, [beach("b0001", "gyeongpo")])).toHaveLength(1);
  });
  it("다른 해변이 쓰던 slug 재사용은 실패", () => {
    const errors = compareWithBase(base, [
      beach("b0001", "gyeongpo"),
      beach("b0002", "sokcho-2"),
      beach("b0003", "sokcho"),
    ]);
    expect(errors.some((e) => e.includes("다시 쓸 수 없어요"))).toBe(true);
  });
});
