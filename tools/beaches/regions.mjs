// BRD-59 전국 판정 공용: 시·도 설정과 저장소 밖 원자료 경로 (결정 기록 11장 10/21, 아키텍처 2.2)
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// 원자료 위치: 저장소 밖. 환경 변수가 없으면 ~/data 아래
export const GIS_DIR = process.env.BARADUN_GIS_DIR ?? join(homedir(), "data/baradun-gis");
export const DATA_DIR = process.env.BARADUN_DATA_DIR ?? join(GIS_DIR, "..");
export const MOF_XLSX = process.env.BARADUN_MOF_XLSX ?? join(DATA_DIR, "2026_해수욕장_현황_해수부.xlsx");
export const BJD_CSV = process.env.BARADUN_BJD_CSV ?? join(DATA_DIR, "국토교통부_법정동코드_20260929.csv");
// 수집본(out/)·구역 근거 json·실응답 저장본(responses/)·생성 중간 산출물(<지역>.json, coverage-<지역>.csv)
export const COVERAGE_DIR = join(DATA_DIR, "baradun-coverage");
export const COAST_DIR = join(GIS_DIR, "coastline_2026");
export const COAST_SHP = join(COAST_DIR, "2026 해안선.shp");
export const COAST_DBF = join(COAST_DIR, "2026 해안선.dbf");

// 증거에 남기는 경로 표기(사람마다 홈 경로가 달라 상대 표기)
export const gisLabel = (rel) => `$BARADUN_GIS_DIR/${rel}`;

// 해수부 수집본 sido_nm → 브이월드 시·도 코드·표시 이름 (전남은 전남광주통합특별시 12, 화면 표시는 '전남')
export const REGIONS = {
  부산: { code: "26", ko: "부산", en: "Busan" },
  인천: { code: "28", ko: "인천", en: "Incheon" },
  울산: { code: "31", ko: "울산", en: "Ulsan" },
  경기: { code: "41", ko: "경기", en: "Gyeonggi" },
  충남: { code: "44", ko: "충남", en: "Chungnam" },
  경북: { code: "47", ko: "경북", en: "Gyeongbuk" },
  경남: { code: "48", ko: "경남", en: "Gyeongnam" },
  제주: { code: "50", ko: "제주", en: "Jeju" },
  강원: { code: "51", ko: "강원", en: "Gangwon" },
  전북: { code: "52", ko: "전북", en: "Jeonbuk" },
  전남: { code: "12", ko: "전남", en: "Jeonnam" },
};
export const emdRel = (code) => `vworld_umd/LSMD_ADM_SECT_UMD_${code}_202610/LSMD_ADM_SECT_UMD_${code}_202610`;
export const emdPaths = (code) => ({ shp: join(GIS_DIR, `${emdRel(code)}.shp`), dbf: join(GIS_DIR, `${emdRel(code)}.dbf`), label: gisLabel(`${emdRel(code)}.shp`) });

const hashCache = new Map();
export const sha256 = (path) => {
  if (!hashCache.has(path)) hashCache.set(path, existsSync(path) ? createHash("sha256").update(readFileSync(path)).digest("hex") : null);
  return hashCache.get(path);
};

// --region 인자 (없으면 강원). '전국'이면 모든 시·도
export function regionArg(argv = process.argv) {
  const i = argv.indexOf("--region");
  const v = i >= 0 ? argv[i + 1] : "강원";
  if (v === "전국") return Object.keys(REGIONS);
  if (!REGIONS[v]) throw new Error(`모르는 시·도: ${v}`);
  return [v];
}
export const regionSlug = (regions) => (regions.length > 1 ? "national" : { 강원: "gangwon" }[regions[0]] ?? `region-${REGIONS[regions[0]].code}`);

// 행정구역 이름이 바뀐 곳: 해수부 수집본 시군 → 현행 경계의 시군 후보 (인천 중구 일부 → 영종구, 2026)
export const SIGUNGU_ALIAS = { "인천|중구": ["중구", "영종구"] };
export const sigunguMatches = (fullName, sido, sigungu) =>
  (SIGUNGU_ALIAS[`${sido}|${sigungu}`] ?? [sigungu]).some((g) => fullName?.endsWith(` ${g}`));
