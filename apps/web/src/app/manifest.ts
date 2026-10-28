import type { MetadataRoute } from "next";

import ko from "../../messages/ko.json";
import { MANIFEST_ICONS } from "@/lib/app-icons";
import { THEME_COLORS } from "@/lib/viewport";

// 웹 앱 매니페스트: 홈 화면에 추가하면 standalone(주소창 없는 앱 창)으로 열림 (아키텍처 9.1 '오프라인', BRD-42)
// 빌드 때 /manifest.webmanifest 한 파일로 나감. 언어별로 나눌 수 없어 기본 언어(한국어) 이름을 씀
// 색은 토큰(bg/page 라이트)에서 가져옴. 매니페스트는 테마별 색을 둘 수 없어 라이트 한 가지(설치 직후 첫 화면·스플래시용)
// 앱이 열린 뒤에는 그리기 전 스크립트(lib/display-init.ts)가 실제로 그리는 테마의 theme-color 줄만 쓰이게 함(결정 35)
// 앱 아이콘: any 192·512 + maskable 512(lib/app-icons.ts, 결정 28). 실기기 설치 확인은 사용자 몫(결정 31)

// 정적 내보내기(output: "export")는 메타데이터 경로에 이 설정이 없으면 빌드를 멈춤
export const dynamic = "force-static";

export default function manifest(): MetadataRoute.Manifest {
  const page = THEME_COLORS.light;
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
    icons: MANIFEST_ICONS,
  };
}
