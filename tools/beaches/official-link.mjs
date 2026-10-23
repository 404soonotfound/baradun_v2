import { SIGUNGU_ALIAS } from "./regions.mjs";

// 이름 안의 '리'·'진'은 지명의 일부임. 표기 예외는 명시적인 대응표로만 연결함.
export const normName = (s) => s.replace(/\([^)]*\)/g, "").replace(/해수욕장|해변/g, "").replace(/\s+/g, "");

export function linkOfficial(src, mofRows, entries) {
  const sigungus = SIGUNGU_ALIAS[`${src.sido_nm}|${src.gugun_nm}`] ?? [src.gugun_nm];
  const pool = mofRows.filter((r) => r.sido === src.sido_nm && sigungus.includes(r.sigungu));
  const pick = (method, list, basis) => list.length === 1
    ? { method, row: list[0], basis }
    : { method: "UNLINKED", candidates: list.map((r) => `${r.name}(${r.row}행)`), basis: `${basis}: 후보 ${list.length}개` };
  const exact = pool.filter((r) => r.name === src.sta_nm);
  if (exact.length) return pick("EXACT", exact, "이름 완전 일치");
  const rule = pool.filter((r) => normName(r.name) === normName(src.sta_nm));
  const matches = entries.filter((x) => x.key === `${src.sido_nm}|${src.gugun_nm}|${src.sta_nm}`);
  if (rule.length === 1) return pick("RULE", rule, `괄호·'해수욕장'·'해변' 차이만(${src.sta_nm} ↔ ${rule[0].name})`);
  if (rule.length > 1) {
    const m = matches.length === 1 ? matches[0] : null;
    const mapped = m ? rule.filter((r) => r.name === m.xlsx_name) : [];
    if (mapped.length === 1) return pick("MAP", mapped, `대응표 name-map-2026.json: ${m.basis}`);
    return pick("RULE", rule, `괄호·'해수욕장'·'해변' 차이만(${src.sta_nm} ↔ ${rule.map((r) => r.name).join("·")})`);
  }
  if (matches.length > 1) return { method: "UNLINKED", candidates: matches.map((m) => m.xlsx_name), basis: "대응표 키 중복 → 연결 안 함" };
  const m = matches[0];
  if (m) return pick("MAP", pool.filter((r) => r.name === m.xlsx_name), `대응표 name-map-2026.json: ${m.basis}`);
  return { method: "UNLINKED", candidates: [], basis: "같은 시군에 이름 완전 일치·규칙 일치·대응표 항목 없음" };
}

export function linkOfficials(sources, mofRows, entries) {
  const links = new Map(sources.map((b) => [`${b.gugun_nm}|${b.sta_nm}`, linkOfficial(b, mofRows, entries)]));
  if (links.size !== sources.length) throw new Error("해변 키(시군|이름) 중복: 시·도를 넘어 같은 키가 있음");
  const use = new Map();
  for (const l of links.values()) if (l.row) use.set(l.row.row, (use.get(l.row.row) ?? 0) + 1);
  for (const [key, l] of links)
    if (l.row && use.get(l.row.row) > 1) links.set(key, { method: "UNLINKED", candidates: [`${l.row.name}(${l.row.row}행)`], basis: `${l.basis} → 같은 행이 다른 해변에도 연결되어 연결 안 함` });
  return links;
}
