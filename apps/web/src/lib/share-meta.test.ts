import type { Beach } from "@baradun/contracts";
import { describe, expect, it } from "vitest";

import {
  beachShareMetadata,
  SHARE_ILLUSTRATION,
  sharePhotoUrl,
} from "./share-meta";

// 공유 미리보기 (BRD-34): 해변 이름·지역·사진만, 상태 없음
const photo: NonNullable<Beach["photo"]> = {
  url: "https://tong.visitkorea.or.kr/img/a.jpg",
  source: "한국관광공사",
  license: "kogl-type1",
};

const beach = {
  slug: "gyeongpo",
  name: { ko: "경포해수욕장", en: "Gyeongpo Beach" },
  region: {
    sido: { ko: "강원", en: "Gangwon" },
    sigungu: { ko: "강릉시", en: "Gangneung" },
  },
  photo,
} satisfies Pick<Beach, "slug" | "name" | "region" | "photo">;

const text = {
  siteName: "바라던 바다",
  photoAlt: "경포해수욕장 사진",
  illustrationAlt: "바다 일러스트",
};

describe("sharePhotoUrl", () => {
  it("1유형 https 사진은 그대로", () => {
    expect(sharePhotoUrl(photo)).toBe(photo.url);
  });

  it("사진이 없으면 null", () => {
    expect(sharePhotoUrl(null)).toBeNull();
  });

  it("1유형이 아니면 null(계약 밖 값이 들어와도 쓰지 않음)", () => {
    const other = {
      ...photo,
      license: "kogl-type3",
    } as unknown as Beach["photo"];
    expect(sharePhotoUrl(other)).toBeNull();
  });

  it("https가 아니거나 형식이 틀린 주소는 null", () => {
    expect(sharePhotoUrl({ ...photo, url: "http://a.kr/x.jpg" })).toBeNull();
    expect(sharePhotoUrl({ ...photo, url: "/local.jpg" })).toBeNull();
    expect(sharePhotoUrl({ ...photo, url: "" })).toBeNull();
  });
});

describe("beachShareMetadata", () => {
  it("이름·지역·사진만 넣음", () => {
    const meta = beachShareMetadata(beach, "ko", text);
    expect(meta.openGraph).toMatchObject({
      title: "경포해수욕장 · 바라던 바다",
      description: "강원 강릉시",
      url: "/spots/gyeongpo/",
      siteName: "바라던 바다",
      locale: "ko_KR",
      images: [{ url: photo.url, alt: "경포해수욕장 사진" }],
    });
    expect(meta.twitter).toMatchObject({
      card: "summary_large_image",
      description: "강원 강릉시",
      images: [{ url: photo.url }],
    });
  });

  it("영어는 영어 이름·지역과 /en 주소", () => {
    const meta = beachShareMetadata(beach, "en", {
      ...text,
      siteName: "Baradun",
    });
    expect(meta.openGraph).toMatchObject({
      title: "Gyeongpo Beach · Baradun",
      description: "Gangwon Gangneung",
      url: "/en/spots/gyeongpo/",
      locale: "en_US",
    });
  });

  it("사진이 없으면 공통 일러스트", () => {
    const meta = beachShareMetadata({ ...beach, photo: null }, "ko", text);
    expect(meta.openGraph?.images).toEqual([
      { ...SHARE_ILLUSTRATION, alt: "바다 일러스트" },
    ]);
    expect(meta.twitter?.images).toEqual([
      { ...SHARE_ILLUSTRATION, alt: "바다 일러스트" },
    ]);
  });

  it("상태를 뜻하는 낱말이 미리보기 어디에도 없음", () => {
    const serialized = JSON.stringify(beachShareMetadata(beach, "ko", text));
    for (const word of [
      "특보",
      "이용불가",
      "판단불가",
      "안전",
      "추천",
      "파고",
    ]) {
      expect(serialized).not.toContain(word);
    }
  });
});
