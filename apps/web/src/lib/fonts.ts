import { Noto_Sans_KR } from "next/font/google";

// 글꼴 (노션 4장: Noto Sans KR 400·500·700·800)
// next/font가 빌드할 때 받아서 우리 사이트 파일로 함께 올림(방문자가 Google에 요청하지 않음).
// 토큰 font.sans가 이 변수(--font-noto-sans-kr)를 씀.
export const notoSansKr = Noto_Sans_KR({
  weight: ["400", "500", "700", "800"],
  subsets: ["latin"],
  display: "swap",
  variable: "--font-noto-sans-kr",
});
