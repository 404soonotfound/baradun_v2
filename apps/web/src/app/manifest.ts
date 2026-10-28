import type { MetadataRoute } from "next";

import ko from "../../messages/ko.json";
import tokens from "../../tokens/tokens.json";

// 웹 앱 매니페스트: 홈 화면에 추가하면 standalone(주소창 없는 앱 창)으로 열림 (아키텍처 9.1 '오프라인', BRD-42)
// 빌드 때 /manifest.webmanifest 한 파일로 나감. 언어별로 나눌 수 없어 기본 언어(한국어) 이름을 씀
// 색은 토큰(bg/page 라이트)에서 가져옴. 다크는 viewport themeColor(media)가 맡음
// 앱 아이콘은 아직 없음(PR '남은 결정'). 아이콘이 없으면 일부 브라우저(안드로이드 Chrome)는 설치 대신 바로가기로 추가함
export default function manifest(): MetadataRoute.Manifest {
  const page = tokens.color.bg.page.$value;
  return {
    id: "/",
    name: ko.meta.siteName,
    short_name: ko.meta.siteName,
    description: ko.meta.description,
    lang: "ko",
    start_url: "/",
    scope: "/",
    display: "standalone",
    background_color: page,
    theme_color: page,
  };
}
