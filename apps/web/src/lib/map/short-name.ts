// 지도 마커의 짧은 이름 (BRD-30 · 노션 2장 EXP-M '마커 = 상태 아이콘 + 짧은 이름')
// "강문해수욕장" → "강문", "Gangmun Beach" → "Gangmun". 이름이 꼬리말뿐이면(예: "해변") 원래 이름 그대로
// 전체 이름은 카드·목록에서 보여 줌. 지도 위 글자를 줄여 지명 라벨과 덜 겹치게 함
const SUFFIXES = [/해수욕장$/, /해변$/, /\s+Beach$/i];

export function shortName(name: string): string {
  const trimmed = name.trim();
  for (const suffix of SUFFIXES) {
    const short = trimmed.replace(suffix, "").trim();
    if (short !== trimmed) return short.length > 0 ? short : trimmed;
  }
  return trimmed;
}
