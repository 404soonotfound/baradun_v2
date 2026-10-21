// BRD-59 해변 초안 생성: <지역>.json(레코드) + coverage-<지역>.csv(매트릭스). 강원은 gangwon, 전국은 national
// 입력: $BARADUN_DATA_DIR/baradun-coverage의 out/·responses/ 수집본만 읽음. <지역>.json·coverage-<지역>.csv도 그곳에 씀. 생성 시 공공데이터 API 호출 없음, 서비스 키 읽지 않음
// 실행: node tools/beaches/build.mjs [--region 강원|전국|<시·도>]
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { METRICS, assignMetric, loadAssignContext, readCsv, round1 } from "./station-assign.mjs";
import { zoneProofVerified } from "./zone-proof.mjs";
import { COVERAGE_DIR, REGIONS, regionArg, regionSlug } from "./regions.mjs";
import { SLIM_COLS, slimMatrix } from "./slim-matrix.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const TARGET_REGIONS = regionArg();
const OUT_NAME = regionSlug(TARGET_REGIONS);
const NATIONAL = JSON.parse(readFileSync(join(HERE, "names-national.json"), "utf8"));
const SRC = join(COVERAGE_DIR, "out");
const LIVE_MATRIX_PATH = join(COVERAGE_DIR, "responses/metric-matrix.json");
const liveMatrix = existsSync(LIVE_MATRIX_PATH) ? JSON.parse(readFileSync(LIVE_MATRIX_PATH, "utf8")) : null;
const liveByStation = new Map((liveMatrix?.stations ?? []).map((s) => [s.stn_id, s]));

const csvCell = (v) => {
  const s = v === null || v === undefined ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
};

const SIGUNGU_EN_GW = {
  강릉시: "Gangneung",
  고성군: "Goseong",
  동해시: "Donghae",
  삼척시: "Samcheok",
  속초시: "Sokcho",
  양양군: "Yangyang",
};

// 관측소 이름 제안 표. 구역 판정에는 별도 독립 검증 입력 사용
const STATION_INFO_GW = {
  "22471": { ko: "토성 파고부이", en: "Toseong wave buoy" },
  "22310": { ko: "고성 해양기상부이", en: "Goseong marine buoy" },
  "22451": { ko: "연곡 파고부이", en: "Yeongok wave buoy" },
  "22520": { ko: "강릉 해양기상부이", en: "Gangneung marine buoy" },
  "22479": { ko: "맹방 파고부이", en: "Maengbang wave buoy" },
  "22311": { ko: "삼척 해양기상부이", en: "Samcheok marine buoy" },
};

const SIGUNGU_EN = { ...NATIONAL.sigunguEn, ...SIGUNGU_EN_GW };
// 관측소 이름: 강원 표가 있으면 그것, 없으면 수집본 이름 + 종류(B 해양기상부이·C 파고부이)
const stationInfo = (id) => {
  if (STATION_INFO_GW[id]) return STATION_INFO_GW[id];
  const s = stations.find((x) => x.stn_id === id);
  const rom = NATIONAL.stationRom[id];
  if (!s || !rom) return null;
  return s.tp === "B" ? { ko: `${s.name} 해양기상부이`, en: `${rom} marine buoy` } : { ko: `${s.name} 파고부이`, en: `${rom} wave buoy` };
};
// ── 이름·slug 표 (국어의 로마자 표기법, 사람이 작성) ──
// rom: 로마자, alias: 별칭, review: 사람 검토 사유. slug는 결정 기록 11장 10/21 ②③ 규칙으로 생성
const NAMES = {
  "강릉시|강문": { rom: "Gangmun" },
  "강릉시|경포": { rom: "Gyeongpo" },
  "강릉시|사근진": { rom: "Sageunjin" },
  "강릉시|사천진": { rom: "Sacheonjin" },
  "강릉시|송정": { rom: "Songjeong" },
  "강릉시|안목": { rom: "Anmok" },
  "강릉시|연곡": { rom: "Yeongok" },
  "강릉시|옥계": { rom: "Okgye" },
  "강릉시|정동진": { rom: "Jeongdongjin" },
  "강릉시|주문진": { rom: "Jumunjin" },
  "강릉시|하평": { rom: "Hapyeong" },
  "강릉시|금진": { rom: "Geumjin" },
  "강릉시|남항진": { rom: "Namhangjin" },
  "강릉시|도직": { rom: "Dojik" },
  "강릉시|등명": { rom: "Deungmyeong" },
  "강릉시|사천": { rom: "Sacheon", review: "경남 사천시(시 이름)와 같은 로마자. 해변 이름 중복은 아님" },
  "강릉시|순긋": { rom: "Sungeut", review: "받침 ㅅ 표기(Sungeut) 확인 필요" },
  "강릉시|안인": { rom: "Anin", review: "음절 경계 모호(An-in) 표기 확인 필요" },
  "강릉시|염전": { rom: "Yeomjeon" },
  "강릉시|영진": { rom: "Yeongjin" },
  "고성군|명파": { rom: "Myeongpa" },
  "고성군|백도": { rom: "Baekdo" },
  "고성군|봉수대": { rom: "Bongsudae" },
  "고성군|삼포": { rom: "Sampo" },
  "고성군|송지호": { rom: "Songjiho" },
  "고성군|송지호오토캠핑장": { rom: "Songjiho Auto Camping", slugOverride: "songjiho-auto-camping", place: true, review: "캠핑장 이름. 해수욕장 이름·slug·영어 표기 확인 필요" },
  "고성군|천진": { rom: "Cheonjin" },
  "고성군|화진포": { rom: "Hwajinpo" },
  "고성군|가진리": { rom: "Gajin-ri" },
  "고성군|거진11리": { rom: "Geojin 11-ri" },
  "고성군|거진1리": { rom: "Geojin 1-ri" },
  "고성군|공현1리": { rom: "Gonghyeon 1-ri" },
  "고성군|공현2리": { rom: "Gonghyeon 2-ri" },
  "고성군|교암리": { rom: "Gyoam-ri" },
  "고성군|대진1리": { rom: "Daejin 1-ri" },
  "고성군|대진5리": { rom: "Daejin 5-ri" },
  "고성군|마차진": { rom: "Machajin" },
  "고성군|문암2리": { rom: "Munam 2-ri" },
  "고성군|반암리": { rom: "Banam-ri" },
  "고성군|봉포": { rom: "Bongpo" },
  "고성군|삼포2리": { rom: "Sampo 2-ri" },
  "고성군|아야진": { rom: "Ayajin" },
  "고성군|자작도": { rom: "Jajakdo" },
  "고성군|청간": { rom: "Cheonggan" },
  "고성군|초도리": { rom: "Chodo-ri" },
  "고성군|캔싱턴리조트": { rom: "Kensington Resort", slugOverride: "kensington-resort", place: true, review: "리조트 이름(외래어). 해수욕장 이름·slug·영어 표기 확인 필요" },
  "동해시|노봉": { rom: "Nobong" },
  "동해시|대진": { rom: "Daejin" },
  "동해시|망상": { rom: "Mangsang" },
  "동해시|망상리조트": { rom: "Mangsang Resort", slugOverride: "mangsang-resort", place: true, review: "리조트 이름. 망상과 별개 해수욕장인지, 이름·slug·영어 표기 확인 필요" },
  "동해시|어달": { rom: "Eodal" },
  "동해시|추암": { rom: "Chuam" },
  "삼척시|덕산": { rom: "Deoksan" },
  "삼척시|맹방": { rom: "Maengbang" },
  "삼척시|문암": { rom: "Munam" },
  "삼척시|부남": { rom: "Bunam" },
  "삼척시|삼척": { rom: "Samcheok" },
  "삼척시|상맹방(승공)": { rom: "Sangmaengbang", ko: "상맹방", alias: ["승공"], review: "수집본 이름 괄호 '(승공)'을 별칭으로 분리함. 확인 필요" },
  "삼척시|오분": { rom: "Obun" },
  "삼척시|용화": { rom: "Yonghwa" },
  "삼척시|원평": { rom: "Wonpyeong" },
  "삼척시|임원": { rom: "Imwon" },
  "삼척시|작은후진": { rom: "Jageunhujin" },
  "삼척시|장호": { rom: "Jangho" },
  "삼척시|증산": { rom: "Jeungsan" },
  "삼척시|하맹방(연봉)": { rom: "Hamaengbang", ko: "하맹방", alias: ["연봉"], review: "수집본 이름 괄호 '(연봉)'을 별칭으로 분리함. 확인 필요" },
  "삼척시|한재밑": { rom: "Hanjaemit", review: "받침 ㅌ 표기(Hanjaemit) 확인 필요" },
  "삼척시|궁촌": { rom: "Gungchon" },
  "속초시|등대": { rom: "Deungdae" },
  "속초시|속초": { rom: "Sokcho" },
  "속초시|외옹치": { rom: "Oeongchi" },
  "양양군|낙산": { rom: "Naksan" },
  "양양군|남애3리": { rom: "Namae 3-ri" },
  "양양군|동호": { rom: "Dongho" },
  "양양군|물치": { rom: "Mulchi" },
  "양양군|설악": { rom: "Seorak" },
  "양양군|지경": { rom: "Jigyeong" },
  "양양군|하조대": { rom: "Hajodae" },
  "양양군|갯마을": { rom: "Gaenmaeul", review: "자음동화 표기(Gaenmaeul) 확인 필요" },
  "양양군|광진": { rom: "Gwangjin" },
  "양양군|남애1리": { rom: "Namae 1-ri" },
  "양양군|동산": { rom: "Dongsan" },
  "양양군|동산포": { rom: "Dongsanpo" },
  "양양군|북분리": { rom: "Bukbun-ri" },
  "양양군|원포": { rom: "Wonpo" },
  "양양군|인구": { rom: "Ingu", review: "V1 slug는 in-gu. V2 표기법 기준 ingu로 만듦(V1 값 옮기지 않음)" },
  "양양군|잔교": { rom: "Jangyo" },
  "양양군|정암": { rom: "Jeongam" },
  "양양군|죽도": { rom: "Jukdo" },
  "양양군|중광정": { rom: "Junggwangjeong" },
};
Object.assign(NAMES, NATIONAL.beaches);
// 좌표 없음 보류 (데이터 출처 문서 12장, 아키텍처 14.5): expected-holds.json 목록
const HELD = new Set(JSON.parse(readFileSync(join(HERE, "expected-holds.json"), "utf8")).coordinates.map((h) => h.key));

const COAST_CODE = { 동해안: "east", 서해안: "west", 남해안: "south", 제주: "jeju" };
const coastOf = (zone) => (!zone ? null : zone.startsWith("S1323") ? "제주" : zone.startsWith("S11") ? "동해안" : zone.startsWith("S12") ? "서해안" : zone.startsWith("S13") ? "남해안" : null);
const slugOf = (rom) =>
  rom
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

// ── 입력 읽기 ──
const allSrc = readCsv("beaches.csv");
const beachesSrc = allSrc.filter((b) => TARGET_REGIONS.includes(b.sido_nm));
// 이름 겹침: 전국 285행에서 괄호를 뺀 해수욕장 이름이 같은 다른 해변 (결정 기록 11장 10/21 ②)
const baseName = (s) => s.replace(/\([^)]*\)/g, "").trim();
const sameNameElsewhere = (src) =>
  allSrc.filter((b) => baseName(b.sta_nm) === baseName(src.sta_nm) && !(b.sido_nm === src.sido_nm && b.gugun_nm === src.gugun_nm && b.sta_nm === src.sta_nm));
const beachEvidenceRows = JSON.parse(readFileSync(join(SRC, "../beach-zone-evidence.json"), "utf8")).beaches;
const beachEvidence = new Map(beachEvidenceRows.map((r) => [r.key, r]));
const stations = readCsv("stations.csv");
const independentStations = JSON.parse(readFileSync(join(SRC, "../station-zone-evidence.json"), "utf8")).stations;
const stationZone = new Map(
  independentStations
    .filter((s) => s.status === "VERIFIED" && s.zone && s.boundary_source_url && s.boundary_rule_item && s.checked_at_kst && s.basis)
    .map((s) => [s.stn_id, s]),
);
if (beachEvidence.size !== beachEvidenceRows.length || new Set(independentStations.map((s) => s.stn_id)).size !== independentStations.length)
  throw new Error("검토 입력 키 중복");
for (const s of stations.filter((row) => ["B", "C"].includes(row.tp))) {
  const evidence = independentStations.find((r) => r.stn_id === s.stn_id);
  if (!evidence || Number(evidence.lat) !== Number(s.lat) || Number(evidence.lon) !== Number(s.lon))
    throw new Error(`관측소 독립 검증 좌표 누락·불일치: ${s.stn_id}`);
}
for (const e of independentStations) {
  if (!["VERIFIED", "UNVERIFIED", "VERIFIED_NOT_IN_ZONE"].includes(e.status)) throw new Error(`관측소 검증 상태 오류: ${e.stn_id}`);
  if (e.status === "VERIFIED_NOT_IN_ZONE" && (e.zone || !e.not_in_zones?.length || !e.basis || !e.checked_at_kst))
    throw new Error(`구역 밖 확정 근거 누락: ${e.stn_id}`);
  if (e.status === "VERIFIED" && !stationZone.has(e.stn_id)) throw new Error(`관측소 검증 근거 누락: ${e.stn_id}`);
  if (e.status !== "VERIFIED" && e.zone) throw new Error(`미검증 관측소에 배정 코드 존재: ${e.stn_id}`);
}
for (const e of beachEvidenceRows) {
  for (const kind of ["address", "land", "sea"])
    if (!["VERIFIED", "UNVERIFIED"].includes(e[`${kind}_status`])) throw new Error(`해변 검증 상태 오류: ${e.key} ${kind}`);
  if (e.address_status === "VERIFIED" && !(e.official_address && e.address_source_url && e.address_checked_at_kst))
    throw new Error(`공식 주소 근거 누락: ${e.key}`);
  for (const kind of ["land", "sea"])
    if (e[`${kind}_status`] === "VERIFIED" && !zoneProofVerified(e, kind, e.key.split("|")[0]))
      throw new Error(`구역 검증 근거 누락: ${e.key} ${kind}`);
}
const expectedHolds = JSON.parse(readFileSync(join(HERE, "expected-holds.json"), "utf8"));
if ([...HELD].some((key) => !expectedHolds.coordinates.some((h) => h.key === key && h.reason)))
  throw new Error("좌표 보류 근거 누락");

const matrixEvidence = (e) => ({
  official_address: e.official_address,
  address_source_url: e.address_source_url,
  address_checked_at_kst: e.address_checked_at_kst,
  address_status: e.address_status === "VERIFIED" ? "주소 확인" : "미검증",
  land_status: zoneProofVerified(e, "land", e.key.split("|")[0]) ? "검증" : "미검증",
  land_rule_url: e.land_rule_url,
  land_rule_item: e.land_rule_item,
  land_checked_at_kst: e.land_checked_at_kst ?? "",
  land_transition_status: e.land_transition_comparison?.status ?? "UNVERIFIED",
  sea_status: zoneProofVerified(e, "sea", e.key.split("|")[0]) ? "검증" : "미검증",
  sea_rule_url: e.sea_rule_url,
  sea_rule_item: e.sea_rule_item,
  sea_checked_at_kst: e.sea_checked_at_kst ?? "",
  sea_source_file: e.sea_source?.file ?? "",
  sea_source_sigungu: e.sea_source?.value ?? "",
  sea_source_sha256: e.sea_source?.sha256 ?? "",
  sea_coordinate_review: e.sea_coordinate_review ?? "UNVERIFIED",
  legacy_land_basis: e.legacy_land_basis,
  official_address_2026: e.official_address_2026?.address ?? "",
  address_link_method: e.official_address_2026?.method ?? "",
  address_link_basis: e.official_address_2026?.basis ?? "",
  address_l1_check: e.land_proof?.address_check ? `${e.land_proof.address_check.result}: ${e.land_proof.address_check.reason}` : "",
  season2026: e.official_address_2026?.season2026
    ? `${e.official_address_2026.season2026.status} ${e.official_address_2026.season2026.openDate ?? ""}~${e.official_address_2026.season2026.closeDate ?? ""}`
    : "",
  land_method: e.land_proof?.method ?? "",
  land_decision: e.land_proof?.decision ?? "",
  land_emd: e.land_proof?.emd ? `${e.land_proof.emd.emd_nm}(${e.land_proof.emd.emd_cd}) ${e.land_proof.emd.distance_m}m` : "",
  land_neighbors_300m: e.land_proof?.neighbors_within_300m?.map((n) => `${n.emd_nm}(${n.emd_cd}) ${n.distance_m}m ${n.l1_code || "별표9 없음"}`).join(" / ") ?? "",
  land_address_comparison: e.land_proof?.address_comparison
    ? `${e.land_proof.address_comparison.official_locality} ${e.land_proof.address_comparison.same_emd ? "= 좌표 읍면" : "≠ 좌표 읍면"}`
    : "",
});

// 배정 규칙·72시간 미수신·지표별 후보는 station-assign.mjs 공용 (spatial-judge.mjs와 같은 판정)
const assignCtx = loadAssignContext();
const { windowStart, windowEnd } = assignCtx;

// ── 해변별 생성 ──
const records = [];
const matrix = [];
const IDS_PATH = join(HERE, "ids.json");
const ids = existsSync(IDS_PATH) ? JSON.parse(readFileSync(IDS_PATH, "utf8")) : { note: "BRD-59 내부 id 대장. 한 번 정한 id는 바꾸거나 다시 쓰지 않음(결정 기록 9장)", ids: {} };
const idKey = (src) => `${src.sido_nm}|${src.gugun_nm}|${src.sta_nm}`;
let nextSeq = Math.max(0, ...Object.values(ids.ids).map((v) => Number(v.slice(1)))) + 1;
const excludedLog = new Map(); // 대표 제외 지점 → 사유
const excludedBeaches = []; // 출시 자동 제외 해변 (결정 4-A)

for (const src of beachesSrc) {
  const key = `${src.gugun_nm}|${src.sta_nm}`;
  const evidence = beachEvidence.get(key);
  if (!evidence) throw new Error(`해변 검토 입력 누락: ${key}`);
  const seaZone = evidence.sea_zone;
  const seaBasis = evidence.sea_basis;

  if (HELD.has(key)) {
    matrix.push({
      // 예전에 id를 받은 해변이 보류로 바뀌면 그 id를 남김(숨긴 해변 파일과 매트릭스 행 연결). 새 id는 만들지 않음
      id: ids.ids[idKey(src)] ?? "",
      sigungu: src.gugun_nm,
      source_name: src.sta_nm,
      name_ko: "",
      slug: "",
      slug_status: "",
      stage: "보류",
      official_id: "",
      official_id_note: "해수부 해수욕장정보 수집본에 ID 칸 없음",
      lat: "",
      lng: "",
      coords_source: "없음(해수부 해수욕장정보 응답에 좌표 없음)",
      coast: coastOf(seaZone) ?? "",
      sea_zone: seaZone,
      sea_basis: seaBasis,
      land_zone: evidence.land_zone,
      land_basis: evidence.land_basis,
      ...matrixEvidence(evidence),
      st_waveHeight: "",
      st_wavePeriod: "",
      st_waveDirection: "",
      st_waterTemp: "",
      st_wind: "",
      station_basis: "좌표 없음 → 거리 계산 불가",
      station_excluded: "",
      occlusion: "",
      activity_candidates: "",
      season_candidates: "",
      response_check: "미확인",
      exclusion: "보류: 좌표 없음(데이터 출처 문서 12장, 아키텍처 14.5). 레코드 만들지 않음",
      review: "예",
      review_reason: "좌표 확보 후 재검토",
    });
    continue;
  }

  const n = NAMES[key];
  if (!n) throw new Error(`이름 표 누락: ${key}`);
  if (!src.lat || !src.lon || !Number.isFinite(Number(src.lat)) || !Number.isFinite(Number(src.lon)))
    throw new Error(`목록에 없는 좌표 보류·형식 오류: ${key}`);
  const lat = Number(Number(src.lat).toFixed(6));
  const lng = Number(Number(src.lon).toFixed(6));
  const id = (ids.ids[idKey(src)] ??= `b${String(nextSeq++).padStart(4, "0")}`);
  const koBase = n.ko ?? src.sta_nm;
  const nameKo = koBase.endsWith("비치") ? koBase : `${koBase}해수욕장`;
  const nameEn = `${n.rom} Beach`;
  if (!SIGUNGU_EN[src.gugun_nm]) throw new Error(`시군 로마자 누락: ${src.gugun_nm}`);
  // 겹치면 시군 로마자를 앞에 붙임(gangneung-songjeong), '리'는 로마자 그대로(munam-2-ri)
  const dups = sameNameElsewhere(src);
  const dupText = dups.length ? dups.map((b) => `${b.sido_nm} ${b.gugun_nm} ${b.sta_nm}`).join(", ") : null;
  const slug = dups.length ? `${slugOf(SIGUNGU_EN[src.gugun_nm])}-${slugOf(n.rom)}` : (n.slugOverride ?? slugOf(n.rom));
  const slugRule = dups.length ? `이름 겹침(${dupText}) → 시군 로마자 접두(결정 기록 11장 10/21 ②)` : "겹침 없음 → 로마자 그대로(결정 기록 11장 10/21 ②③)";
  const aliases = [...new Set([src.sta_nm, koBase, ...(n.alias ?? [])])].filter((a) => a !== nameKo);

  // 관측소: station-assign.mjs 규칙(결정 4-A). 20km 안 미검증 관측소가 배정·부재 확정을 막으면 UNDETERMINED
  const seaVerified = zoneProofVerified(evidence, "sea", src.gugun_nm);
  const landVerified = zoneProofVerified(evidence, "land", src.gugun_nm);
  const stationsOut = {};
  const basisParts = [];
  const excludedHere = [];
  const undetermined = [];
  const absent = [];
  const gapped = []; // 결측·지연으로 확정 불가인 지표
  for (const metric of Object.keys(METRICS)) {
    const a = assignMetric(assignCtx, { lat, lng, seaZone, seaVerified }, metric);
    const listText = a.list.map((c) => `${c.s.stn_id} ${c.s.name}(${c.s.tp}) ${round1(c.km)}km`).join(" / ") || "20km 안 후보 없음";
    for (const t of a.skipped.filter((x) => /미수신|대표 제외/.test(x))) {
      excludedHere.push(`${metric} ${t}`);
      if (/미수신/.test(t)) excludedLog.set(t.split(" ")[0], t);
    }
    if (a.state === "ASSIGNED") {
      const info = stationInfo(a.chosen.stn_id);
      if (!info) throw new Error(`관측소 이름 표 누락: ${a.chosen.stn_id}`);
      stationsOut[metric] = { id: a.chosen.stn_id, name: { ko: info.ko, en: info.en }, distanceKm: round1(a.km) };
      basisParts.push(`${metric}[${METRICS[metric].source}]: ${listText} → ${a.chosen.stn_id}`);
    } else {
      stationsOut[metric] = null;
      if (a.state === "ABSENT") absent.push(metric);
      else undetermined.push(`${metric}: ${a.reason}`);
      if (a.state === "UNDETERMINED" && a.reason.includes("결측·지연")) gapped.push(metric);
      basisParts.push(`${metric}[${METRICS[metric].source}]: ${listText} → ${a.state === "ABSENT" ? `null(가까운 관측 없음: ${a.reason})` : `확정 불가(${a.reason})`}`);
    }
  }
  const usedStations = [...new Set(Object.values(stationsOut).filter(Boolean).map((s) => s.id))];
  const stationZoneBasis = usedStations.map((sid) => `${sid} 구역: ${stationZone.get(sid).basis}`).join(" / ");
  const stationMappingStatus = undetermined.length ? "UNVERIFIED" : "VERIFIED";

  // 판정 입력(beach-zone-evidence.json)의 자동 제외·부재 근거와 같은 결과인지 확인
  const notDesignated = (evidence.release_exclusion?.items ?? []).some((i) => i.type === "NOT_DESIGNATED_2026"); // 7차: 지정 목록 밖
  const excluded = !landVerified || undetermined.length > 0 || notDesignated;
  if (excluded !== Boolean(evidence.release_exclusion?.items?.length))
    throw new Error(`자동 제외 판정 불일치: ${key} (생성 ${excluded}, 입력 ${Boolean(evidence.release_exclusion)})`);
  if (absent.join() !== Object.keys(METRICS).filter((m) => evidence.station_absence?.[m]?.status === "VERIFIED").join())
    throw new Error(`관측 부재 판정 불일치: ${key}`);

  const matrixBase = {
    id,
    sigungu: src.gugun_nm,
    source_name: src.sta_nm,
    name_ko: nameKo,
    slug: slug ?? "",
    slug_status: `${n.review ? "사람 검토 필요" : "규칙 확정"}: ${slugRule}`,
    official_id: "",
    official_id_note: "해수부 해수욕장정보 수집본에 ID 칸 없음",
    lat,
    lng,
    coords_source: "해수부 해수욕장정보 API(2026-10-16 수집)",
    coast: coastOf(seaZone) ?? "",
    sea_zone: seaZone,
    sea_basis: seaBasis,
    land_zone: evidence.land_zone,
    land_basis: evidence.land_basis,
    ...matrixEvidence(evidence),
  };
  const fmt = (metric) => {
    const s = stationsOut[metric];
    if (s) return `${s.id} ${s.name.ko} ${s.distanceKm}km`;
    if (absent.includes(metric)) return "null(가까운 관측 없음)";
    return gapped.includes(metric) ? "null(결측·지연으로 확정 불가)" : "null(미검증 관측소로 확정 불가)";
  };
  const stationCols = {
    st_waveHeight: fmt("waveHeight"),
    st_wavePeriod: fmt("wavePeriod"),
    st_waveDirection: fmt("waveDirection"),
    st_waterTemp: fmt("waterTemp"),
    st_wind: fmt("wind"),
    station_basis: `${basisParts.join(" ; ")}${stationZoneBasis ? ` ; ${stationZoneBasis}` : ""}`,
    station_excluded: excludedHere.length ? excludedHere.join(" / ") : "72시간 미수신·대표 제외에 따른 제외 없음",
    occlusion: "미검토(지도 확인 안 함)",
    activity_candidates: "",
    season_candidates: "",
    response_check: "실응답 3차 저장본 재사용(2026-10-20T15:00:00Z, sea_obs·kma_buoy HTTP 200, 새 호출 없음)",
  };

  // 출시 자동 제외(결정 4-A): 레코드 만들지 않고 매트릭스에 사유 기록
  if (excluded) {
    const items = evidence.release_exclusion.items;
    excludedBeaches.push({ id, key, sourceName: src.sta_nm, items });
    matrix.push({
      ...matrixBase,
      stage: "자동 제외",
      ...stationCols,
      exclusion: `자동 제외(결정 4-A): ${items.map((i) => `[${i.type}] ${i.reason}`).join(" / ")}`,
      review: "아니오",
      review_reason: "",
    });
    continue;
  }

  // 사람 검토 사유 (이름·slug만 남음. 구역·관측소는 규칙으로 확정)
  const reviews = [];
  if (n.place) reviews.push("장소(리조트·캠핑장) 이름으로 만든 해수욕장 이름");
  if (n.review) reviews.push(n.review);

  // 검증된 구역만 본문에 포함하고 미검증 코드는 후보 칸으로 분리
  const verifiedZones = {};
  const zoneCandidates = {};
  for (const [kind, code] of Object.entries({ sea: seaZone, land: evidence.land_zone })) {
    if (zoneProofVerified(evidence, kind, src.gugun_nm)) verifiedZones[kind] = code;
    else zoneCandidates[kind] = code;
  }

  const record = {
    id,
    slug,
    kind: "beach", // 해수부 지정 해수욕장(2026 현황 연결, 결정 기록 11장 10/21 ⑧)
    name: { ko: nameKo, en: nameEn },
    region: {
      sido: { ko: REGIONS[src.sido_nm].ko, en: REGIONS[src.sido_nm].en },
      sigungu: { ko: src.gugun_nm, en: SIGUNGU_EN[src.gugun_nm] },
    },
    coast: COAST_CODE[coastOf(seaZone)],
    coords: { lat, lng },
    activities: ["swimming"],
    hidden: false,
    ...(Object.keys(verifiedZones).length ? { warningZones: verifiedZones } : {}),
    stations: {
      waveHeight: stationsOut.waveHeight,
      wavePeriod: stationsOut.wavePeriod,
      waveDirection: stationsOut.waveDirection,
      waterTemp: stationsOut.waterTemp,
      wind: stationsOut.wind,
    },
    photo: null,
    cctv: null,
    _draft: {
      idNote: "임시 번호. 전국 확정 때 다시 매김",
      sourceName: src.sta_nm,
      zoneEvidence: matrixEvidence(evidence),
      zoneCandidates,
      stationMappingStatus,
      stationVerification: Object.fromEntries(Object.keys(METRICS).map((metric) => [metric,
        stationsOut[metric] ? stationZone.get(stationsOut[metric].id)?.metrics?.[metric]?.status ?? "UNVERIFIED" : absent.includes(metric) ? "ABSENT" : "UNVERIFIED",
      ])),
      aliases,
      coast: coastOf(seaZone),
      coordsSource: "해양수산부 해수욕장정보 OceansBeachInfoService1/getOceansBeachInfo1 (2026-10-16 수집, tools/coverage/out/beaches.csv), 소수 6자리 반올림",
      nameKoStatus: n.place || n.ko ? "사람 검토 필요" : "수집본 이름 + 해수욕장",
      nameEnStatus: "규칙 확정('<로마자> Beach', 결정 기록 11장 10/21 ③)",
      slugStatus: n.review ? "사람 검토 필요" : "규칙 확정",
      slugRule,
      slugCandidates: [slug],
      duplicateNames: dupText,
      // 2026 운영 기간(공개 계약 밖). 해수부 '2026 해수욕장 주요 현황' 연결된 해변만
      season2026: evidence.official_address_2026?.season2026
        ? { ...evidence.official_address_2026.season2026, source: evidence.official_address_2026.source.name, sourceUrl: evidence.official_address_2026.source.url, xlsxRow: evidence.official_address_2026.xlsx_row, linkMethod: evidence.official_address_2026.method }
        : { status: null, reason: `공식 현황 미연결: ${evidence.official_address_2026?.basis ?? "입력 없음"}` },
      windNote: liveByStation.size ? "실응답 저장본(2026-10-20T15:00:00Z) 기준. 파고부이(C)는 바람 결측(-99)이 많음" : "실응답 확인 필요(바람 값 유무 미확인)",
      activityCandidates: null,
      activityCandidatesNote: "국립해양조사원 서핑·스쿠버 포인트 목록 입력 없음 → 후보 비움",
      seasonNameCandidates: null,
      seasonNote: "해수부 '전국 해수욕장 개장 및 폐장 일정' 파일 입력 없음 → 후보 비움",
      review: reviews,
    },
  };
  records.push(record);
  matrix.push({
    ...matrixBase,
    stage: "SOURCE_CANDIDATE",
    ...stationCols,
    exclusion: "",
    review: reviews.length ? "예" : "아니오",
    review_reason: reviews.join(" / "),
  });
}

// ── 쓰기 ──
const out = {
  _meta: {
    issue: `BRD-59 해변 초안 (${TARGET_REGIONS.join("·")})`,
    generatedBy: "tools/beaches/build.mjs",
    note: "data/beaches 반영 전 초안. 레코드의 _draft는 Beach 계약 밖 검토용 칸. slug가 null이면 전국 확정 때 결정",
    sources: [
      "tools/coverage/out/beaches.csv (해수부 해수욕장정보, 2026-10-16)",
      "tools/coverage/beach-zone-evidence.json (좌표–법정 읍면동 경계 L1 판정·해상 구역·자동 제외 입력)",
      "tools/coverage/out/stations.csv, tools/coverage/station-zone-evidence.json (관측소 좌표·독립 검증 입력)",
      "tools/coverage/out/freshness/sea_obs_72h.csv, kma_buoy2_7d.csv (72시간 미수신 판정)",
      "예보업무규정(기상청훈령 제1185호, 2026-06-01 시행) 별표4·5·9",
    ],
    window72h: `${windowStart}~${windowEnd} KST (sea_obs 요청 시각)`,
    excludedStations: Object.fromEntries(excludedLog),
    releaseExcluded: excludedBeaches,
  },
  beaches: records,
};
writeFileSync(join(COVERAGE_DIR, `${OUT_NAME}.json`), `${JSON.stringify(out, null, 2)}\n`);
writeFileSync(IDS_PATH, `${JSON.stringify(ids, null, 2)}\n`);

const cols = Object.keys(matrix[0]);
const csv = [cols.join(","), ...matrix.map((r) => cols.map((c) => csvCell(r[c])).join(","))].join("\n");
writeFileSync(join(COVERAGE_DIR, `coverage-${OUT_NAME}.csv`), `﻿${csv}\n`);
console.log(`레코드 ${records.length}곳, 매트릭스 ${matrix.length}행(보류 ${matrix.filter((r) => r.stage === "보류").length}, 자동 제외 ${excludedBeaches.length})`);

if (process.argv.includes("--publish")) {
  // 공개 파일(아키텍처 17.5): data/beaches/<id>.json(Beach 계약 그대로), data/beach-meta.json(별칭·운영 기간, 계약 밖),
  // data/beach-coverage.csv(BeachCoverageMatrix). check.mjs 통과본에서만 실행
  if (TARGET_REGIONS.length < 2) throw new Error("--publish는 --region 전국에서만");
  const DATA = join(HERE, "../../data");
  const strip = ({ _draft, ...beach }) => beach;
  // 전부 검사·생성한 뒤에 씀(중간 실패로 일부만 바뀌지 않게)
  for (const r of records)
    if (typeof r.slug !== "string" || !r.warningZones?.sea || !r.warningZones?.land) throw new Error(`승격 불가 레코드: ${r.id}`);
  const BEACH_DIR = join(DATA, "beaches");
  // 지금 파일 한 번만 읽음(파일 이름 = id, beach-rules.mjs). check-beaches.mjs와 같이 .json 파일 전부 대상, README 등 다른 파일은 그대로
  const existing = new Map(
    readdirSync(BEACH_DIR)
      .filter((f) => f.endsWith(".json"))
      .map((f) => [f.slice(0, -".json".length), JSON.parse(readFileSync(join(BEACH_DIR, f), "utf8"))]),
  );
  // 이번 공개 대상에 없는 해변(보류·자동 제외로 바뀜)은 지우지 않고 hidden: true로 숨김(data/beaches/README, beach-rules.mjs 삭제 금지)
  const keep = new Set(records.map((r) => r.id));
  const hidden = [...existing].filter(([id]) => !keep.has(id)).map(([id, beach]) => [id, { ...beach, hidden: true }]);
  // 매트릭스 행이 없는 파일(원자료에서 빠진 해변, 사람이 직접 추가한 해변)은 숨김 근거가 없어 check-coverage.mjs가 실패하므로 쓰기 전에 멈춤
  const matrixIds = new Set(matrix.map((r) => r.id).filter(Boolean));
  const orphans = hidden.filter(([id]) => !matrixIds.has(id)).map(([id]) => id);
  if (orphans.length) throw new Error(`매트릭스 행 없는 해변 파일(원자료에서 빠졌거나 직접 추가함): ${orphans.join(", ")}`);
  // 이미 hidden: true인 공개 대상은 숨김 유지(사람이 숨긴 해변이 다음 생성에서 다시 공개되지 않게). 다시 공개는 사람이 false로 바꿈
  const stillHidden = new Set(records.filter((r) => existing.get(r.id)?.hidden === true).map((r) => r.id));
  const meta = {
    _meta: {
      note: "해변 부가 정보(공개 계약 밖, 결정 기록 11장 10/21 ⑤). 해변 id로 data/beaches와 연결. 검색 별칭·운영 기간",
      season_source: "해양수산부 해양레저관광과 '2026 해수욕장 주요 현황'(2026-08-11), https://www.mof.go.kr/doc/ko/selectDoc.do?menuSeq=427&bbsSeq=2&docSeq=67910",
      season_rule: "올해 일정이 없거나 연결되지 않으면 '운영 기간 아님' 배지를 숨김(지난해 일정으로 추정 안 함, 결정 기록 11장 10/21 ⑥)",
    },
    beaches: Object.fromEntries(records.map((r) => [r.id, {
      aliases: r._draft.aliases,
      season: { 2026: r._draft.season2026.status ? { status: r._draft.season2026.status === "개장" ? "open" : "closed", openDate: r._draft.season2026.openDate, closeDate: r._draft.season2026.closeDate, sourceRow: r._draft.season2026.xlsxRow, link: r._draft.season2026.linkMethod } : null },
    }])),
  };
  // 공개본은 해변별 결과 칸만(slim-matrix.mjs). 전체 매트릭스는 위 coverage-<지역>.csv
  const csv2 = [SLIM_COLS.join(","), ...slimMatrix(matrix).map((r) => SLIM_COLS.map((c) => csvCell(r[c])).join(","))].join("\n");
  for (const r of records)
    writeFileSync(join(BEACH_DIR, `${r.id}.json`), `${JSON.stringify({ ...strip(r), ...(stillHidden.has(r.id) ? { hidden: true } : {}) }, null, 2)}\n`);
  for (const [id, beach] of hidden) writeFileSync(join(BEACH_DIR, `${id}.json`), `${JSON.stringify(beach, null, 2)}\n`);
  if (hidden.length) console.log(`공개 대상에서 빠진 해변 숨김(hidden: true) ${hidden.length}개: ${hidden.map(([id]) => id).join(", ")}`);
  if (stillHidden.size) console.log(`이미 숨긴 해변 숨김 유지 ${stillHidden.size}개: ${[...stillHidden].join(", ")}`);
  writeFileSync(join(DATA, "beach-meta.json"), `${JSON.stringify(meta, null, 2)}\n`);
  writeFileSync(join(DATA, "beach-coverage.csv"), `${csv2}\n`);
  console.log(`공개 파일: data/beaches ${records.length - stillHidden.size}곳(숨김 ${hidden.length + stillHidden.size}곳 별도), beach-meta.json, beach-coverage.csv ${matrix.length}행`);
}
