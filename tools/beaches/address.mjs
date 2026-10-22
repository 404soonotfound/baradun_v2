import { annex9Lookup, sidoOfName, splitFull } from "./annex.mjs";
import { SIGUNGU_ALIAS } from "./regions.mjs";

// 현행 법정동 이름만 사용함. 구가 있는 시는 시와 구를 모두 남김.
export function legalLocalities(fullNames) {
  const rows = new Map();
  for (const full of fullNames) {
    const { sido, sigungu, district } = splitFull(full);
    const tokens = full.split(/\s+/);
    const locality = tokens[district ? 3 : 2];
    if (!sido || !/(읍|면|동|가)$/.test(locality ?? "")) continue;
    const key = `${sido}|${sigungu}|${district ?? ""}|${locality}`;
    rows.set(key, { sido, sigungu, district, locality });
  }
  return [...rows.values()];
}

export const legalNameSet = (rows) => new Set(rows.map((r) => `${r.sido}|${r.sigungu}|${r.locality}`));

export function addressLocality(address, sido, sigungu, legalRows) {
  const tokens = address.trim().split(/[\s,]+/);
  const statedSido = sidoOfName(tokens[0]);
  if (statedSido && statedSido !== sido) return { status: "INVALID_LOCALITY", locality: "", reason: "주소 시도가 수집본과 다름" };
  const sigungus = SIGUNGU_ALIAS[`${sido}|${sigungu}`] ?? [sigungu];
  const i = tokens.findIndex((t) => sigungus.includes(t));
  if (i < 0) return { status: "INVALID_LOCALITY", locality: "", reason: "주소 시군이 수집본과 다름" };
  const district = tokens[i].endsWith("시") && tokens[i + 1]?.endsWith("구") ? tokens[i + 1] : null;
  // 읍면동 미독해로 좌표 판정에 넘기기 전에, 주소가 명시한 시군·구부터 검증함.
  // 시군 개편은 SIGUNGU_ALIAS에 명시된 대응만 허용함(공식 저장본의 인천 중구 → 영종구).
  const jurisdiction = legalRows.filter((r) => r.sido === sido && sigungus.includes(r.sigungu) && (!district || r.district === district));
  if (!jurisdiction.length) return { status: "INVALID_LOCALITY", locality: "", reason: "주소의 시군·구가 현행 법정 이름 집합에 없음" };
  const next = tokens[i + (district ? 2 : 1)] ?? "";
  const parens = [...address.matchAll(/\(([^)]*)\)/g)].map((m) => m[1].split(/[\s,]+/)[0]);
  const names = [...new Set([next, ...parens].filter((n) => /(읍|면|동|가)$/.test(n)))];
  if (!names.length) return { status: "NO_LOCALITY", locality: "", reason: "주소에서 읍면동을 읽지 못함" };
  const hits = jurisdiction.filter((r) => names.includes(r.locality));
  if (hits.length !== 1 || names.length !== 1) return { status: "INVALID_LOCALITY", locality: names.join("·"), reason: "현행 법정 읍면동의 시도·시군·구 소속이 없거나 여러 후보임" };
  const hit = hits[0];
  const rows = annex9Lookup(hit.sido, hit.sigungu, hit.locality, legalNameSet(legalRows));
  return { status: "VERIFIED_LOCALITY", locality: hit.locality, sigungu: hit.sigungu, district: hit.district, rows };
}
