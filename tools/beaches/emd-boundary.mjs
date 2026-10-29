// BRD-126 법정 읍면동 경계 읽기: 국토교통부 법정구역정보(브이월드 dsId=21, CC BY 2.0 KR) 전국 전체데이터 SHP의 읍면동(EMD) 층
// 컬럼은 브이월드 '국가중점데이터 컬럼정의서' 테이블정의서(전체) 법정구역정보 읍면동(EMD) AL_D001 기준:
//   A0 원천도형ID · A1 읍면동 코드(8자리) · A2 읍면동 명 · A3 데이터기준일자 · A4 원천시도시군구코드(5자리)
// 변동데이터(CH_D001)는 A4가 변동순번이고 A5 입력구분·A6 원천시도시군구코드가 붙음 → 전국 판정에 쓰지 않음
// 판정 코드는 종전 이름(EMD_CD·EMD_NM·COL_ADM_SE)을 그대로 씀. 형식이 다르거나 비면 고르지 않고 중단
import { readDbf, readShp } from "./geo-kit.mjs";

export const EMD_COLUMNS = { EMD_CD: "A1", EMD_NM: "A2", COL_ADM_SE: "A4" };
const CHANGE_ONLY_COLUMNS = ["A5", "A6"];
const POLYGON_TYPES = new Set([5, 15, 25]); // 폴리곤·PolygonZ·PolygonM

// dbf 문자 칸의 빈 값은 공백 대신 NUL로 채워져 올 수 있음(변동데이터 실파일 확인)
const clean = (v) => (v ?? "").replace(/\0/g, "").trim();
// A1 앞 5자리와 A4가 같은 시군구인지. 구가 있는 시는 A1이 구 코드(예: 48125 마산합포구), A4가 시 코드(48120 창원시)라
// 앞 4자리가 같고 A4가 0으로 끝날 때만 같은 시로 봄(2026-10-09 전국 자료 5,067행 중 775행이 이 경우, 그 밖의 불일치 0행)
const sameSigungu = (emdCd, sgg) => emdCd.slice(0, 5) === sgg || (emdCd.slice(0, 4) === sgg.slice(0, 4) && sgg.endsWith("0"));

// sidoCodes: 법정동코드 시·도 앞 두 자리 목록(regions.mjs REGIONS). A4 앞 두 자리로 거르고, 시·도마다 읍면동이 하나 이상 있어야 함
export function readEmdBoundary({ shp, dbf, encoding }, sidoCodes) {
  if (!encoding) throw new Error("읍면동 경계 dbf 인코딩이 data-sources.json에 고정되지 않음 → 판정 중단");
  const attr = readDbf(dbf, encoding);
  if (!attr.length) throw new Error("읍면동 경계 dbf 레코드 없음");
  const changeCols = CHANGE_ONLY_COLUMNS.filter((c) => c in attr[0]);
  if (changeCols.length) throw new Error(`읍면동 경계가 변동데이터(CH_D001) 형식(${changeCols.join("·")} 있음) → 전체데이터(AL_D001)가 아니라 판정 중단`);
  const missing = Object.values(EMD_COLUMNS).filter((c) => !(c in attr[0]));
  if (missing.length) throw new Error(`읍면동 경계 dbf에 컬럼 없음: ${missing.join("·")} (컬럼정의서 A1·A2·A4와 다름)`);
  // 형식 검사는 dbf 전 행에 적용
  const rows = attr.map((a, i) => {
    const row = { EMD_CD: clean(a.A1), EMD_NM: clean(a.A2), COL_ADM_SE: clean(a.A4) };
    const problem = !/^\d{8}$/.test(row.EMD_CD) ? "읍면동 코드 형식 오류(8자리 숫자 아님)"
      : !/^\d{5}$/.test(row.COL_ADM_SE) ? "시군구 코드 형식 오류(5자리 숫자 아님)"
      : !row.EMD_NM ? "읍면동 이름 없음"
      : row.EMD_NM.includes(String.fromCharCode(0xfffd)) ? "읍면동 이름 깨짐(인코딩 다름)"
      : null;
    if (problem) throw new Error(`읍면동 경계 ${problem}(레코드 ${i}): ${JSON.stringify(row)}`);
    if (!sameSigungu(row.EMD_CD, row.COL_ADM_SE)) throw new Error(`읍면동 코드와 시군구 코드가 다름(레코드 ${i}): ${JSON.stringify(row)}`);
    return row;
  });
  // 해안 시·도 도형만 좌표를 읽음. 빈 도형(유형 0)·점 등은 keep에 오지 않아 개수가 달라짐 → 중단
  let seen = 0;
  const badType = [];
  const shapes = readShp(shp, {
    keep: (_, i, type) => {
      seen++;
      if (!POLYGON_TYPES.has(type)) badType.push(`${i}:${type}`);
      return POLYGON_TYPES.has(type) && sidoCodes.includes(rows[i]?.COL_ADM_SE.slice(0, 2));
    },
  });
  if (badType.length) throw new Error(`읍면동 경계 도형 유형 다름(폴리곤 5·15·25만): ${badType.slice(0, 5).join(", ")}`);
  if (seen !== attr.length) throw new Error(`읍면동 shp·dbf 개수 불일치: 도형 ${seen} / 속성 ${attr.length}`);
  const out = shapes.map((sh) => ({ ...sh, ...rows[sh.index] }));
  const empty = sidoCodes.filter((code) => !out.some((e) => e.COL_ADM_SE.startsWith(code)));
  if (empty.length) throw new Error(`읍면동 경계에 시·도 경계 없음: ${empty.join("·")} (시·도 코드 체계가 바뀌었는지 확인) → 판정 중단`);
  return out;
}
