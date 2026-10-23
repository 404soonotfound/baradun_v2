import type { ZoneTables } from "../core/warnings/beach-warnings";

// 공식 구역표 (별표5 앞바다 S1·별표9 육상 L1, 아키텍처 4장 10/20)
// 원본은 tools/beaches/annex-tables.json(BRD-59 원문 인용표). 여기서는 코드 → 공식 이름만 꺼냄
// 같은 코드가 다른 이름으로 두 번 나오면 원문이 어긋난 것 → 게시를 멈춤(이름을 골라 쓰지 않음)

export interface AnnexTables {
  readonly annex5: {
    readonly zones: Readonly<Record<string, { readonly name: string }>>;
  };
  readonly annex9: {
    readonly sigungu: Readonly<
      Record<
        string,
        {
          readonly rows: readonly {
            readonly name: string;
            readonly code: string;
          }[];
        }
      >
    >;
  };
}

export function zoneTablesFromAnnex(annex: AnnexTables): ZoneTables {
  const sea: Record<string, string> = {};
  for (const [code, zone] of Object.entries(annex.annex5.zones)) {
    sea[code] = zone.name;
  }
  const land: Record<string, string> = {};
  for (const { rows } of Object.values(annex.annex9.sigungu)) {
    for (const { code, name } of rows) {
      if (land[code] !== undefined && land[code] !== name) {
        throw new RangeError(`육상 구역 이름이 둘: ${code}`);
      }
      land[code] = name;
    }
  }
  return { sea, land };
}
