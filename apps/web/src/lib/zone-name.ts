import type { Locale } from "@/lib/i18n";
import { ZONE_NAMES_EN } from "@/lib/zone-names-en";

// 특보 구역 이름 표시 (아키텍처 9.1: 특보 종류·구역·시각만 사람이 만든 번역표로 영어 표시, 기계 번역 안 함)
// 번역표(lib/zone-names-en.ts)는 기상청 공식 영어 이름만 둠. 표에 없는 구역·지진해일(구역 코드 없음, reg 원문)은 원문 그대로
// 표의 한국어 이름과 게시된 구역 이름이 다르면(구역표가 바뀌었거나 코드가 어긋남) 영어로 바꾸지 않고 원문
// untranslated: 한국어가 아닌 화면에서 원문을 그대로 보여주는 중 → 화면이 'Original text from KMA (Korean)'을 붙임

type ZoneTable = Readonly<
  Record<string, { readonly ko: string; readonly en: string }>
>;

export function zoneNameText(
  zone: { zoneCode: string | null; zoneName: string },
  locale: Locale,
  table: ZoneTable = ZONE_NAMES_EN,
): { text: string; untranslated: boolean } {
  if (locale === "ko") return { text: zone.zoneName, untranslated: false };
  const entry = zone.zoneCode === null ? undefined : table[zone.zoneCode];
  return entry && entry.ko === zone.zoneName
    ? { text: entry.en, untranslated: false }
    : { text: zone.zoneName, untranslated: true };
}

// 사유의 범위 글자(reasons[].scope, 코드 없이 구역 이름만 옴) → 같은 규칙. 표의 한국어 이름과 정확히 같을 때만 영어
export function zoneScopeText(
  scope: string,
  locale: Locale,
  table: ZoneTable = ZONE_NAMES_EN,
): { text: string; untranslated: boolean } {
  if (locale === "ko") return { text: scope, untranslated: false };
  const entry = Object.values(table).find((zone) => zone.ko === scope);
  return entry
    ? { text: entry.en, untranslated: false }
    : { text: scope, untranslated: true };
}
