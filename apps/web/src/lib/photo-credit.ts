import type { Beach } from "@baradun/contracts";

// 해변 사진 출처 링크 (BRD-113 · 공공누리 제1유형: 온라인에서 링크가 가능하면 출처 웹사이트 링크를 제공)
// 사진은 한국관광공사 국문 관광정보 서비스(TourAPI, 공공데이터포털 15101578)에서 1유형만 가져옴(결정 기록 11장 10/21)

export const TOUR_API_URL = "https://www.data.go.kr/data/15101578/openapi.do";

type Photo = NonNullable<Beach["photo"]>;

// 원본 페이지가 있으면 그 주소, 없으면 한국관광공사 사진은 TourAPI 안내 주소.
// 모르는 출처는 링크를 지어내지 않음(null → 이름만 글자로)
export function photoSourceUrl(
  photo: Pick<Photo, "source" | "pageUrl">,
): string | null {
  if (photo.pageUrl) return photo.pageUrl;
  return photo.source === "한국관광공사" ? TOUR_API_URL : null;
}
