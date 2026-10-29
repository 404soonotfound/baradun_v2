// BRD-126 법정 읍면동 경계 읽기: 국토교통부 법정구역정보(브이월드 dsId=21, CC BY 2.0 KR) 전국 전체데이터 SHP의 읍면동(EMD) 층
// 컬럼은 브이월드 '국가중점데이터 컬럼정의서' 테이블정의서(전체) 법정구역정보 읍면동(EMD) AL_D001 기준:
//   A0 원천도형ID · A1 읍면동 코드(8자리) · A2 읍면동 명 · A3 데이터기준일자 · A4 원천시도시군구코드(5자리)
// 변동데이터(CH_D001)는 A4가 변동순번이고 A5 입력구분·A6 원천시도시군구코드가 붙음 → 전국 판정에 쓰지 않음
// 판정 코드는 종전 이름(EMD_CD·EMD_NM·COL_ADM_SE)을 그대로 씀. 형식이 다르거나 비면 고르지 않고 중단
import { readDbf, readShp } from "./geo-kit.mjs";

export const EMD_COLUMNS = { EMD_CD: "A1", EMD_NM: "A2", COL_ADM_SE: "A4" };
const CHANGE_ONLY_COLUMNS = ["A5", "A6"];

// dbf 문자 칸의 빈 값은 공백 대신 NUL로 채워져 올 수 있음(변동데이터 실파일 확인)
const clean = (v) => (v ?? "").replace(/\0/g, "").trim();

// sidoCodes: 법정동코드 시·도 앞 두 자리 목록(regions.mjs REGIONS). A4 앞 두 자리로 거름
export function readEmdBoundary({ shp, dbf, encoding }, sidoCodes) {
  if (!encoding) throw new Error("읍면동 경계 dbf 인코딩이 data-sources.json에 고정되지 않음 → 판정 중단");
  const attr = readDbf(dbf, encoding);
  const shapes = readShp(shp);
  if (!attr.length) throw new Error("읍면동 경계 dbf 레코드 없음");
  const changeCols = CHANGE_ONLY_COLUMNS.filter((c) => c in attr[0]);
  if (changeCols.length) throw new Error(`읍면동 경계가 변동데이터(CH_D001) 형식(${changeCols.join("·")} 있음) → 전체데이터(AL_D001)가 아니라 판정 중단`);
  const missing = Object.values(EMD_COLUMNS).filter((c) => !(c in attr[0]));
  if (missing.length) throw new Error(`읍면동 경계 dbf에 컬럼 없음: ${missing.join("·")} (컬럼정의서 A1·A2·A4와 다름)`);
  // 빈 도형(유형 0)·지원하지 않는 도형이 있으면 개수가 달라져 중단
  if (attr.length !== shapes.length) throw new Error(`읍면동 shp·dbf 개수 불일치: 도형 ${shapes.length} / 속성 ${attr.length}`);
  const rows = shapes.map((sh) => {
    const a = attr[sh.index];
    const row = { EMD_CD: clean(a.A1), EMD_NM: clean(a.A2), COL_ADM_SE: clean(a.A4) };
    if (!/^\d{8}$/.test(row.EMD_CD) || !/^\d{5}$/.test(row.COL_ADM_SE) || !row.EMD_NM || row.EMD_NM.includes("�"))
      throw new Error(`읍면동 경계 속성 형식 오류(레코드 ${sh.index}): ${JSON.stringify(row)}`);
    return { ...sh, ...row };
  });
  return rows.filter((e) => sidoCodes.includes(e.COL_ADM_SE.slice(0, 2)));
}
