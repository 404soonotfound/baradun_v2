import type { Viewport } from "next";

import tokens from "../../tokens/tokens.json";

// 두 루트 레이아웃이 같이 쓰는 viewport (BRD-24)
// - viewport-fit=cover: 노치까지 화면을 쓰고, 안전 영역은 CSS env()로 비움 (노션 4장 '화면 틀')
// - themeColor: 브라우저 주소창 색. 색값을 직접 쓰지 않고 토큰(bg/page)에서 확인
const page = tokens.color.bg.page;

export const sharedViewport: Viewport = {
  viewportFit: "cover",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: page.$value },
    {
      media: "(prefers-color-scheme: dark)",
      color: page.$extensions.baradun.dark,
    },
  ],
};
