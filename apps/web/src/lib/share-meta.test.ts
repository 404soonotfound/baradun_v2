import { readFileSync } from "node:fs";

import type { Beach } from "@baradun/contracts";
import { describe, expect, it } from "vitest";

import {
  beachShareMetadata,
  SHARE_ILLUSTRATION,
  siteShareMetadata,
} from "./share-meta";

// 공유 미리보기 (BRD-34 · BRD-105): 해변 이름·지역만, 상태 없음. 이미지는 항상 자체 공통 일러스트
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

const text = { siteName: "바라던 바다", illustrationAlt: "바다 일러스트" };
const illustration = [{ ...SHARE_ILLUSTRATION, alt: "바다 일러스트" }];

describe("beachShareMetadata", () => {
  it("이름·지역과 공통 일러스트만 넣음", () => {
    const meta = beachShareMetadata(beach, "ko", text);
    expect(meta.openGraph).toMatchObject({
      title: "경포해수욕장 · 바라던 바다",
      description: "강원 강릉시",
      url: "/spots/gyeongpo/",
      siteName: "바라던 바다",
      locale: "ko_KR",
    });
    expect(meta.twitter).toMatchObject({
      card: "summary_large_image",
      description: "강원 강릉시",
    });
  });

  it("공공누리 1유형 사진이 있어도 해변 사진을 쓰지 않음(출처 표기 의무, 확정 결정 16)", () => {
    const meta = beachShareMetadata(beach, "ko", text);
    expect(meta.openGraph?.images).toEqual(illustration);
    expect(meta.twitter?.images).toEqual(illustration);
    expect(JSON.stringify(meta)).not.toContain(photo.url);
  });

  it("사진이 없어도 같은 공통 일러스트", () => {
    const noPhoto = { ...beach, photo: null };
    const meta = beachShareMetadata(noPhoto, "ko", text);
    expect(meta.openGraph?.images).toEqual(illustration);
    expect(meta.twitter?.images).toEqual(illustration);
  });

  it("영어는 영어 이름·지역과 /en 주소", () => {
    const meta = beachShareMetadata(beach, "en", {
      siteName: "Baradun",
      illustrationAlt: "Sea illustration",
    });
    expect(meta.openGraph).toMatchObject({
      title: "Gyeongpo Beach · Baradun",
      description: "Gangwon Gangneung",
      url: "/en/spots/gyeongpo/",
      locale: "en_US",
      images: [{ ...SHARE_ILLUSTRATION, alt: "Sea illustration" }],
    });
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

describe("siteShareMetadata", () => {
  it("모든 페이지 기본값: 공통 일러스트와 큰 이미지 카드", () => {
    const meta = siteShareMetadata("ko", text);
    expect(meta.openGraph).toEqual({
      type: "website",
      siteName: "바라던 바다",
      locale: "ko_KR",
      images: illustration,
    });
    expect(meta.twitter).toEqual({
      card: "summary_large_image",
      images: illustration,
    });
  });

  it("영어는 en_US", () => {
    expect(siteShareMetadata("en", text).openGraph).toMatchObject({
      locale: "en_US",
    });
  });
});

describe("SHARE_ILLUSTRATION", () => {
  it("사이트 안 경로의 PNG(외부 주소 아님)", () => {
    expect(SHARE_ILLUSTRATION.url).toBe("/og/share.png");
  });

  it("실제 파일 크기가 메타 width·height와 같음(PNG IHDR)", () => {
    const png = readFileSync(
      new URL(`../../public${SHARE_ILLUSTRATION.url}`, import.meta.url),
    );
    expect(png.subarray(1, 4).toString("ascii")).toBe("PNG");
    expect(png.readUInt32BE(16)).toBe(SHARE_ILLUSTRATION.width);
    expect(png.readUInt32BE(20)).toBe(SHARE_ILLUSTRATION.height);
  });
});
