// 문의 접수 뒤 돌아갈 곳 (BRD-129 · 2026-10-30 사용자 결정 A, Figma 180:243 '해변으로 돌아가기')
// 장소 상세에서 들어와 주소에 ?beach=slug가 있고 그 slug가 공개 해변 목록에 있으면 그 해변 상세
// 그 밖(쿼리 없음·빈 값·모르는 slug·노출 끈 해변)은 설정. 경로는 언어 접두어 없이 돌려주고 화면이 붙임
export type InquiryReturn =
  { kind: "beach"; path: string } | { kind: "settings"; path: "/settings/" };

export function inquiryReturn(
  slug: string | null,
  beaches: readonly { slug: string }[],
): InquiryReturn {
  const found =
    slug === null || slug.trim() === ""
      ? undefined
      : beaches.find((beach) => beach.slug === slug);
  return found
    ? { kind: "beach", path: `/spots/${found.slug}/` }
    : { kind: "settings", path: "/settings/" };
}
