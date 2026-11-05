import type { Locale } from "@/lib/i18n";

// 기상청 중기예보 육상 구역 코드 → 화면 이름 (BRD-185 · 결정 기록 18장 D18-2)
// 계약 이름은 기상청 원문('강원영동', '서울.인천.경기')이라 띄어 쓰고 가운뎃점으로 바꾼 이름을 둠
// 대응표(data/weather-areas.json)에 있는 8곳. 모르는 코드는 계약 이름 그대로(지어내지 않음)
const MID_LAND_NAMES: Record<string, Record<Locale, string>> = {
  "11B00000": { ko: "서울·인천·경기", en: "Seoul·Incheon·Gyeonggi" },
  "11C20000": { ko: "충남", en: "South Chungcheong" },
  "11D20000": { ko: "강원 영동", en: "Gangwon East Coast" },
  "11F10000": { ko: "전북", en: "Jeonbuk" },
  "11F20000": { ko: "전남", en: "South Jeolla" },
  "11G00000": { ko: "제주", en: "Jeju" },
  "11H10000": { ko: "경북", en: "North Gyeongsang" },
  "11H20000": { ko: "경남", en: "South Gyeongsang" },
};

export function midLandName(
  regId: string,
  fallback: string | null,
  locale: Locale,
): string | null {
  return MID_LAND_NAMES[regId]?.[locale] ?? fallback;
}
