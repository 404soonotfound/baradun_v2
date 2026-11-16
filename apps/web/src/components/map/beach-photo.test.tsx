import { readFileSync } from "node:fs";

import { NextIntlClientProvider } from "next-intl";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { BeachIllustration } from "@/components/beach-illustration";
import tokens from "@baradun/design-tokens/tokens.json";
import ko from "../../../messages/ko.json";

import { PhotoFigure, pickShownPhoto } from "./beach-photo";

const photo = {
  url: "https://example.test/gyeongpo.jpg",
  title: "경포해변",
  source: "한국관광공사",
  license: "kogl-type1",
} as const;

function html(node: ReactNode) {
  return renderToStaticMarkup(
    <NextIntlClientProvider locale="ko" messages={ko} timeZone="Asia/Seoul">
      {node}
    </NextIntlClientProvider>,
  );
}

describe("pickShownPhoto", () => {
  it("사진이 없으면 그림 자리(null)", () => {
    expect(pickShownPhoto(null, null)).toBeNull();
  });
  it("받지 못한 주소면 그림 자리(null)", () => {
    expect(pickShownPhoto(photo, photo.url)).toBeNull();
  });
  it("다른 해변(다른 주소)으로 바뀌면 다시 사진을 시도함", () => {
    const next = { ...photo, url: "https://example.test/naksan.jpg" };
    expect(pickShownPhoto(next, photo.url)).toBe(next);
  });
});

describe("PhotoFigure 사진 없음", () => {
  it("해변 그림 + '사진 없음 · 그림' 표시, 사진·파도 아이콘 없음", () => {
    const out = html(
      <PhotoFigure shown={null} name="사천진" onError={() => {}} credit />,
    );
    expect(out).toContain('aria-label="사진 없는 해변 그림"');
    expect(out).toContain("사진 없음 · 그림");
    expect(out).not.toContain("<img");
    expect(out).not.toContain("사진이 없어 일러스트로");
  });
  it("공유 시트 미리보기(empty=icon)는 파도 아이콘 + 안내 그대로", () => {
    const out = html(
      <PhotoFigure
        shown={null}
        name="사천진"
        onError={() => {}}
        credit
        empty="icon"
      />,
    );
    expect(out).toContain("사진이 없어 일러스트로 보여드려요");
    expect(out).not.toContain("사진 없는 해변 그림");
  });
  it("사진이 있으면 사진 + 참고 사진 안내", () => {
    const out = html(
      <PhotoFigure
        shown={photo}
        name="경포"
        onError={() => {}}
        credit={false}
      />,
    );
    expect(out).toContain(`src="${photo.url}"`);
    expect(out).toContain("참고 사진 · 지금 바다 모습 아님");
    expect(out).not.toContain("사진 없음 · 그림");
  });
  // 지도 카드·문의 해변 카드·공유 시트가 같이 쓰는 출처 줄. 공공누리 유형 이름은 두지 않음(GH-541 · D29-10)
  it("사진 출처는 기관 링크와 작품명만", () => {
    const out = html(
      <PhotoFigure shown={photo} name="경포" onError={() => {}} credit />,
    );
    expect(out).toMatch(/사진 출처: <a [^>]*>한국관광공사/);
    expect(out).toContain("「경포해변」");
    expect(out).not.toContain("공공누리");
  });
});

// 원본 SVG와 화면 부품이 같은 그림인지(한쪽만 고쳐 어긋나지 않게): 도형·선 굵기·투명도, 색(토큰 라이트 값)
describe("BeachIllustration", () => {
  const source = readFileSync(
    new URL("../../../assets/illustration/beach-no-photo.svg", import.meta.url),
    "utf8",
  );
  const rendered = html(<BeachIllustration />);
  const shapes = (svg: string) =>
    [...svg.matchAll(/<(svg|g|rect|circle|path)\b([^>]*?)\/?>/g)].map(
      ([, tag, attrs]) =>
        `${tag} ${[
          ...attrs!.matchAll(
            /\b(viewBox|preserveAspectRatio|stroke-width|stroke-linecap|opacity|d|x|y|cx|cy|r|rx|width|height)="([^"]*)"/g,
          ),
          // 칠 없음(fill="none")과 그라데이션 연결(하늘·바다). 그라데이션 id는 화면마다 달라 이름만 봄
          ...attrs!.matchAll(/\b(fill)="(none|url\(#[^)]*\))"/g),
        ]
          .filter(([, key]) => tag !== "svg" || !/^(width|height)$/.test(key!))
          .map(
            ([, key, value]) =>
              `${key}=${value!.replace(/url\(#.*?(sky|sea).*\)/, "url($1)")}`,
          )
          .sort()
          .join(" ")}`,
    );
  it("원본 assets/illustration/beach-no-photo.svg와 도형이 같음", () => {
    expect(shapes(rendered)).toHaveLength(16);
    expect(shapes(rendered)).toEqual(shapes(source));
  });
  it("원본 색이 화면 부품이 쓰는 color.illust.* 라이트 값과 같음(같은 순서)", () => {
    const illust: Record<string, unknown> = tokens.color.illust;
    const used = [
      ...rendered.matchAll(/(?:fill-|stroke-|--color-)illust-([a-z0-9-]+)/g),
    ].map(([, name]) => (illust[name!] as { $value: string }).$value);
    const drawn = [...source.matchAll(/#[0-9A-Fa-f]{6,8}\b/g)].map(
      ([color]) => color,
    );
    expect(used).toHaveLength(10);
    expect(drawn).toEqual(used);
  });
});
