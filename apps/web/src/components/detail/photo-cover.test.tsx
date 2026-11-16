import { NextIntlClientProvider } from "next-intl";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import ko from "../../../messages/ko.json";

import { PhotoCover } from "./photo-cover";

const photo = {
  url: "https://tong.visitkorea.or.kr/cms/resource/25/4075925_image2_1.jpg",
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

// 상세 사진 커버 (GH-528 · 결정 기록 29장 D29-1·D29-8)
describe("PhotoCover", () => {
  it("사진이 없으면 아무것도 그리지 않음(빈 자리·그림 없음)", () => {
    expect(html(<PhotoCover photo={null} name="사천진해수욕장" />)).toBe("");
  });

  it("사진 + '<해변명> 참고 사진' 대체 텍스트 + 참고 사진 표시 + 짧은 출처(링크)", () => {
    const out = html(<PhotoCover photo={photo} name="경포해수욕장" />);
    expect(out).toContain(`src="${photo.url}"`);
    expect(out).toContain('alt="경포해수욕장 참고 사진"');
    expect(out).toContain("참고 사진 · 지금 바다 모습 아님");
    // '사진 한국관광공사': 출처 이름은 새 창 링크. 공공누리 유형 이름은 사진 옆에 두지 않음(GH-541 · D29-10)
    expect(out).toMatch(
      /사진 <a href="[^"]+" target="_blank" rel="noopener noreferrer"[^>]*>한국관광공사/,
    );
    expect(out).not.toContain("공공누리");
    expect(out).not.toContain("사진 출처:");
    // 다크 밝기 공통 규칙 · 가운데 위쪽 고정
    expect(out).toContain("photo-dim");
    expect(out).toContain("object-[center_30%]");
  });

  it("작품명이 있으면 출처 뒤에 붙임(지금 표기 규칙 그대로)", () => {
    const out = html(
      <PhotoCover photo={{ ...photo, title: "경포해변" }} name="경포" />,
    );
    expect(out).toContain("「경포해변」");
    expect(out).not.toContain("공공누리");
  });

  it("모르는 출처는 링크 없이 이름만", () => {
    const out = html(
      <PhotoCover photo={{ ...photo, source: "어느 기관" }} name="경포" />,
    );
    expect(out).toContain("사진 어느 기관");
    expect(out).not.toContain("공공누리");
    expect(out).not.toContain("<a ");
  });
});
