import type { Locale } from "@/lib/i18n";

// 특보 구역 이름 표시 (아키텍처 9.1: 특보 종류·구역·시각만 사람이 만든 번역표로 영어 표시, 기계 번역 안 함)
// 번역표는 BRD-48에서 채움. 표에 없는 구역·지진해일(구역 코드 없음, reg 원문)은 기상청 원문 그대로 돌려줌.
// untranslated: 한국어가 아닌 화면에서 원문을 그대로 보여주는 중 → 화면이 "As issued by KMA (Korean)"을 붙임

// 특보구역 코드 → 영어 이름. 지금은 비어 있어 모든 구역이 원문
const ZONE_NAMES_EN: Readonly<Record<string, string>> = {};

export function zoneNameText(
  zone: { zoneCode: string | null; zoneName: string },
  locale: Locale,
  table: Readonly<Record<string, string>> = ZONE_NAMES_EN,
): { text: string; untranslated: boolean } {
  if (locale === "ko") return { text: zone.zoneName, untranslated: false };
  const en = zone.zoneCode === null ? undefined : table[zone.zoneCode];
  return en
    ? { text: en, untranslated: false }
    : { text: zone.zoneName, untranslated: true };
}
