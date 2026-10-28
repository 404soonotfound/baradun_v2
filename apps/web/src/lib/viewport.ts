import type { Viewport } from "next";

import tokens from "../../tokens/tokens.json";

// 두 루트 레이아웃과 전역 404가 같이 쓰는 viewport (BRD-24)
// - viewport-fit=cover: 노치까지 화면을 쓰고, 안전 영역은 CSS env()로 비움 (노션 4장 '화면 틀')
// - themeColor: 브라우저 주소창 색. 색값을 직접 쓰지 않고 토큰(bg/page)에서 확인
//   여기 media 두 줄은 기기 설정만 따르는 기본값(스크립트가 돌기 전·못 돌 때). 설정에서 고른 테마는
//   그리기 전 스크립트(lib/display-init.ts)가 두 줄의 media를 바꿔 고른 테마 색 줄만 쓰이게 함(결정 35)
//   두 색은 서로 달라야 함(스크립트가 줄의 색으로 어느 테마 줄인지 알아봄, display-init.test.ts가 확인)
const page = tokens.color.bg.page;

// 테마별 theme-color. 화면 바탕(bg/page)과 같은 색
export const THEME_COLORS = {
  light: page.$value,
  dark: page.$extensions.baradun.dark,
} as const;

export const sharedViewport: Viewport = {
  viewportFit: "cover",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: THEME_COLORS.light },
    { media: "(prefers-color-scheme: dark)", color: THEME_COLORS.dark },
  ],
};
