// BRD-59 별표 원문 인용표(annex-tables.json) 조회. 원문에 없는 값은 만들지 않음(null)
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const ANNEX = JSON.parse(readFileSync(join(HERE, "annex-tables.json"), "utf8"));
export const ANNEX5 = ANNEX.annex5.zones;
export const ANNEX5_URL = ANNEX.annex5.url;
export const ANNEX9_URL = ANNEX.annex9.url;
export const ANNEX9_ITEM = ANNEX.annex9.item;
export const ANNEX9_CHECKED = ANNEX.annex9.checked_at_kst;

// 법정동 전체 이름의 시·도 부분 → 수집본 sido_nm
const SIDO_FULL = {
  강원특별자치도: "강원", 강원도: "강원", 경상북도: "경북", 경상남도: "경남", 전남광주통합특별시: "전남", 전라남도: "전남",
  전북특별자치도: "전북", 전라북도: "전북", 제주특별자치도: "제주", 부산광역시: "부산", 인천광역시: "인천", 울산광역시: "울산",
  경기도: "경기", 충청남도: "충남", 충청북도: "충북", 서울특별시: "서울", 대구광역시: "대구", 대전광역시: "대전", 광주광역시: "광주", 세종특별자치시: "세종",
};
export const sidoOfName = (name) => SIDO_FULL[name] ?? (Object.values(SIDO_FULL).includes(name) ? name : null);
// '경상북도 포항시 남구' → { sido: 경북, sigungu: 포항시 } (구가 있는 시는 시 이름)
export function splitFull(full) {
  const [head, ...rest] = full.split(" ");
  const sido = SIDO_FULL[head] ?? null;
  const sigungu = rest[0] ?? "";
  const district = rest[0]?.endsWith("시") && rest[1]?.endsWith("구") ? rest[1] : null;
  return { sido, sigungu, district };
}

// 별표5: 시군(읍면) → 앞바다 구역. 한 구역으로만 정해질 때만 값, 아니면 null
export function zoneOf(sido, sigungu, emd = null) {
  const hits = Object.entries(ANNEX5).filter(([, z]) =>
    z.members.some((m) => {
      if (m.sido !== sido) return false;
      if (m.sigungu === "*" ? (m.exceptSigungu ?? []).includes(sigungu) : m.sigungu !== sigungu) return false;
      if (m.emd) return emd !== null && m.emd.includes(emd);
      if (m.exceptEmd) return emd !== null && !m.exceptEmd.includes(emd);
      return true;
    }),
  );
  return hits.length === 1 ? hits[0][0] : null;
}
export const zoneOfFull = (full, emd = null) => {
  const { sido, sigungu } = splitFull(full);
  return sido ? zoneOf(sido, sigungu, emd) : null;
};
// 시군이 읍면 단위로 나뉘는지 (나뉘면 읍면 없이 정할 수 없음)
export const sigunguIsSplit = (sido, sigungu) =>
  Object.values(ANNEX5).some((z) => z.members.some((m) => m.sido === sido && m.sigungu === sigungu && (m.emd || m.exceptEmd)));

// 별표9: 시군·읍면 → 육상 구역 행
export function annex9Lookup(sido, sigungu, emdName, legalNames) {
  // all·제외목록은 소속이 검증된 읍면동에만 적용함. 집합 없이는 긍정 판정하지 않음.
  if (!legalNames?.has(`${sido}|${sigungu}|${emdName}`)) return [];
  const t = ANNEX.annex9.sigungu[`${sido}|${sigungu}`];
  if (!t) return [];
  return t.rows
    .filter((r) => r.all || (r.list ? r.list.includes(emdName) : !r.exceptList.includes(emdName)))
    .map((r) => ({ row: r.name, code: r.code, quote: r.quote ?? `${sigungu}(${r.list.join(", ")})`, assumption: r.assumption }));
}

// 별표4 광역 경계(위도선)
export const ANNEX4_BOUNDARIES = ANNEX.annex4_boundaries;
