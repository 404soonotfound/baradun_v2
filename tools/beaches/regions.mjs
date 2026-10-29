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

// 해수부 수집본 sido_nm → 법정동코드 시·도 앞 두 자리·표시 이름 (전남은 전남광주통합특별시 12, 화면 표시는 '전남')
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
const hashCache = new Map();
export const sha256 = (path) => {
  if (!hashCache.has(path)) hashCache.set(path, existsSync(path) ? createHash("sha256").update(readFileSync(path)).digest("hex") : null);
  return hashCache.get(path);
};

// 원자료 고정 해시(data-sources.json, 검토한 원자료). 지금 파일 해시만 기록하면 오래되거나 잘못 둔 자료로도 VERIFIED가 되므로 판정·생성 전에 대조
export const MOF_LABEL = "$BARADUN_DATA_DIR/2026_해수욕장_현황_해수부.xlsx";
export const BJD_LABEL = "$BARADUN_DATA_DIR/국토교통부_법정동코드_20260929.csv";
const PINNED = JSON.parse(readFileSync(new URL("./data-sources.json", import.meta.url), "utf8")).files;
const pinnedPath = (label, coverageDir = COVERAGE_DIR) =>
  label === MOF_LABEL ? MOF_XLSX
  : label === BJD_LABEL ? BJD_CSV
  : label.startsWith("$BARADUN_DATA_DIR/baradun-coverage/") ? join(coverageDir, label.slice("$BARADUN_DATA_DIR/baradun-coverage/".length))
  : label.replace("$BARADUN_GIS_DIR", () => GIS_DIR).replace("$BARADUN_DATA_DIR", () => DATA_DIR); // 함수로 넘김: 경로 안 '$&' 등을 치환 패턴으로 해석하지 않게
export const pinnedSha = (label) => PINNED.find((f) => f.path === label)?.sha256 ?? null;

// 법정 읍면동 경계: 국토교통부 법정구역정보(브이월드 dsId=21) 전국 전체데이터 SHP의 읍면동(EMD) 층
// 경로·해시·dbf 인코딩은 data-sources.json의 role 항목에서 읽음. 받은 파일로 고정하기 전(sha256·encoding null)에는 판정·생성 중단
const pinnedRole = (role) => {
  const hits = PINNED.filter((f) => f.role === role);
  if (hits.length !== 1) throw new Error(`data-sources.json에 ${role} 항목이 하나가 아님`);
  return hits[0];
};
const emdShp = pinnedRole("emd_boundary_shp");
const emdDbf = pinnedRole("emd_boundary_dbf");
export const EMD_SOURCE = {
  name: emdShp.name,
  source_url: emdShp.source_url,
  base_date: emdShp.base_date,
  license: emdShp.license,
  license_url: emdShp.license_url,
  attribution: emdShp.attribution,
  label: emdShp.path,
  dbfLabel: emdDbf.path,
  shp: pinnedPath(emdShp.path),
  dbf: pinnedPath(emdDbf.path),
  encoding: emdDbf.encoding ?? null,
};

// 하나라도 없거나, 고정 해시가 비었거나, 해시가 다르면 중단
export function verifyPinnedSources(coverageDir = COVERAGE_DIR) {
  hashCache.clear(); // 같은 프로세스에서 재실행해도 바뀐 원자료를 다시 확인함
  const bad = PINNED.map((f) => [f, sha256(pinnedPath(f.path, coverageDir))])
    .filter(([f, now]) => !f.sha256 || now !== f.sha256)
    .map(([f, now]) => `${f.path}(${!f.sha256 ? "고정 해시 없음" : now ? "해시 다름" : "파일 없음"})`);
  if (bad.length) throw new Error(`원자료가 data-sources.json 고정 해시와 다름 → 생성 중단: ${bad.join(" / ")}`);
}

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
