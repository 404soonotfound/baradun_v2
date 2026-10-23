import { readFileSync, readdirSync } from "node:fs";
import { expect, it } from "vitest";
import { sameImage } from "../photo-sources.mjs";

// 대표 사진 TourAPI 관광지 대장(data/photo-sources.json, BRD-58)
// 사진이 있는 해변은 모두 대장에 있어야 collect-catalog가 매일 유형을 다시 확인할 수 있음

const data = new URL("../../../data/", import.meta.url);
const ledger = JSON.parse(
  readFileSync(new URL("photo-sources.json", data), "utf8"),
) as {
  beaches: Record<
    string,
    { contentId: string; title: string; image: string; url: string }
  >;
};
const photos = readdirSync(new URL("beaches/", data))
  .filter((f) => f.endsWith(".json"))
  .map(
    (f) =>
      JSON.parse(readFileSync(new URL(`beaches/${f}`, data), "utf8")) as {
        id: string;
        photo: { url: string } | null;
      },
  )
  .filter((b) => b.photo !== null)
  .sort((a, b) => a.id.localeCompare(b.id));

it("사진이 있는 해변과 대장의 해변이 정확히 같음(새 사진은 photo-sources.mjs로 대장도 갱신)", () => {
  expect(Object.keys(ledger.beaches).sort()).toEqual(photos.map((b) => b.id));
});

it("대장의 사진 주소가 해변 파일의 photo.url과 같음(수집기는 대장 주소로 확인함)", () => {
  for (const beach of photos) {
    expect(ledger.beaches[beach.id]!.url, beach.id).toBe(beach.photo!.url);
  }
});

it("대장 항목은 관광지 id(숫자)와 이미지 종류(first·detail)만 받음", () => {
  for (const [id, entry] of Object.entries(ledger.beaches)) {
    expect(entry.contentId, id).toMatch(/^[0-9]+$/);
    expect(["first", "detail"], id).toContain(entry.image);
  }
});

it("http·https 차이만 있으면 같은 사진", () => {
  expect(
    sameImage(
      "http://tong.visitkorea.or.kr/a.jpg",
      "https://tong.visitkorea.or.kr/a.jpg",
    ),
  ).toBe(true);
  expect(sameImage("", "")).toBe(false);
  expect(sameImage("https://x/a.jpg", "https://x/b.jpg")).toBe(false);
});
