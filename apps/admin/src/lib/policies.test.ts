import { describe, expect, it } from "vitest";
import committed from "../content/ops-policy.json";
import { parsePolicySnapshot, policyTime, sectionOf } from "./policies";

// 운영 정책 원본 파일 확인 (#335, 결정 기록 D20-8~11·D16-E5)

const clone = () =>
  JSON.parse(JSON.stringify(committed)) as Record<string, unknown> & {
    sections: Record<string, unknown>[];
    source: Record<string, unknown>;
  };

describe("parsePolicySnapshot", () => {
  it("저장소 파일은 9개 항목·revision·가져온 시각·노션 원문 주소를 담는다", () => {
    const snapshot = parsePolicySnapshot(committed);
    expect(snapshot.sections.map((s) => s.number)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9,
    ]);
    expect(snapshot.sections.map((s) => s.title)).toEqual([
      "판단 원칙·표현 원칙",
      "지연·실패 기준",
      "해변 노출·사진",
      "출처 표기",
      "개인정보·위치",
      "장애 대응",
      "공지",
      "운영 권한",
      "문의 응대",
    ]);
    expect(snapshot.source.url).toMatch(/^https:\/\/app\.notion\.com\/p\//);
    expect(Date.parse(snapshot.revision)).toBeLessThanOrEqual(
      Date.parse(snapshot.fetchedAt),
    );
    for (const s of snapshot.sections) {
      expect(s.items.length).toBeGreaterThanOrEqual(3);
      expect(s.items.length).toBeLessThanOrEqual(6);
      expect(s.basis).not.toBe("");
    }
  });

  it("원본에 '안전해요'·추천 같은 보장 표현을 새로 만들지 않는다(원본 글 그대로)", () => {
    const text = JSON.stringify(committed);
    expect(text).not.toMatch(/안전해요|추천해요/);
  });

  it.each<[string, (raw: ReturnType<typeof clone>) => void]>([
    ["schema 다름", (r) => (r.schema = 2)],
    ["항목 8개", (r) => r.sections.pop()],
    ["번호 뒤섞임", (r) => (r.sections[2]!.number = 5)],
    ["상태 모름", (r) => (r.sections[0]!.status = "검토 중")],
    ["빈 내용", (r) => (r.sections[0]!.items = [])],
    [
      "줄 2개",
      (r) => (r.sections[0]!.items = [[{ text: "a" }], [{ text: "b" }]]),
    ],
    [
      "줄 7개",
      (r) =>
        (r.sections[0]!.items = Array.from({ length: 7 }, () => [
          { text: "a" },
        ])),
    ],
    [
      "빈 줄",
      (r) =>
        (r.sections[0]!.items = [
          [{ text: "a" }],
          [{ text: "b" }],
          [{ text: "  " }],
        ]),
    ],
    [
      "모르는 꾸밈",
      (r) => (r.sections[0]!.items = [[{ text: "a", link: "https://x.test" }]]),
    ],
    ["근거 없음", (r) => (r.sections[0]!.basis = "")],
    ["revision 모양", (r) => (r.revision = "2026-11-12")],
    ["가져온 시각 없음", (r) => delete r.fetchedAt],
    [
      "revision이 가져온 시각보다 늦음",
      (r) => (r.revision = "2099-01-01T00:00:00.000Z"),
    ],
    ["노션 밖 주소", (r) => (r.source.url = "https://example.test/p/1")],
  ])("%s이면 빌드를 멈춘다", (_, change) => {
    const raw = clone();
    change(raw);
    expect(() => parsePolicySnapshot(raw)).toThrow();
  });
});

describe("sectionOf", () => {
  const snapshot = parsePolicySnapshot(committed);
  it.each([
    ["1", 1],
    ["9", 9],
  ])("?id=%s → %i번", (id, n) => {
    expect(sectionOf(snapshot, id)?.number).toBe(n);
  });
  it.each([null, "", "0", "10", "01", "1a", "-1"])("%s는 null", (id) => {
    expect(sectionOf(snapshot, id)).toBeNull();
  });
});

describe("policyTime", () => {
  it("KST로 바꾸고 연도를 붙인다(해를 넘긴 동기화가 올해처럼 보이지 않게)", () => {
    expect(policyTime("2026-11-12T15:15:22.234Z")).toBe("2026/11/13 00:15");
    expect(policyTime("2025-12-31T14:59:00.000Z")).toBe("2025/12/31 23:59");
    expect(policyTime("2025-12-31T15:00:00.000Z")).toBe("2026/01/01 00:00");
  });
});
