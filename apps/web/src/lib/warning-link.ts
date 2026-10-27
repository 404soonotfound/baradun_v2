import type { WarningType } from "@baradun/contracts";

// '기상청 원문 보기' 주소 (BRD-33 · 결정 기록 11장 10/27 ④: 계약 칸 + 기상청 원문 링크, 발표문 본문은 후속)
// 기상청 날씨누리 공식 페이지(2026-10-27 확인). 특보마다 원문 주소를 계약에 두지 않아 목록 페이지로 보냄
//   풍랑·강풍·태풍·폭풍해일: '특보 통보문' 목록
//   지진해일: 지진·지진해일 최근 발표(지진해일 정보는 기상특보 통보문이 아니라 지진 쪽에서 발표)
export const KMA_WARNING_TEXT_URL =
  "https://www.weather.go.kr/w/special-report/list.do";
export const KMA_TSUNAMI_URL =
  "https://www.weather.go.kr/w/earthquake-volcano/recent.do";

export function kmaOriginalUrl(type: WarningType): string {
  return type === "tsunami" ? KMA_TSUNAMI_URL : KMA_WARNING_TEXT_URL;
}
