// BRD-59 강원 4차: L1·관측소 S1 자동 판정 (아키텍처 2.2 'L1·관측소 자동 판정 (10/21, 결정 4-A)')
// 입력: 브이월드 법정 읍면동 경계(강원)·국립해양조사원 2026 해안선·법정동코드,
//       $BARADUN_GIS_DIR/vworld_umd 경북 읍면동 경계(해안선 시군 판정용),
//       $BARADUN_DATA_DIR/baradun-coverage의 out/ 수집본·responses/metric-matrix.json(3차 실응답 저장본). API 호출 없음, 서비스 키 읽지 않음
// 출력: $BARADUN_DATA_DIR/baradun-coverage/beach-zone-evidence.json·station-zone-evidence.json 갱신 (--dry면 요약만 출력)
// 실행: node tools/beaches/spatial-judge.mjs [--dry] (저장소 맨 위에서)
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { bboxDist, boundaryDist, buildPolygonIndex, clipMidpoint, insidePolygon, readDbf, readShp, segDist, toEpsg5186, toEpsg5186Snyder } from "./geo-kit.mjs";
import { readFirstSheet } from "./xlsx-lite.mjs";
import { METRICS, assignMetric, haversineKm, loadAssignContext, readCsv, round1 } from "./station-assign.mjs";
import { zoneProofVerified } from "./zone-proof.mjs";
import { ANNEX, ANNEX4_BOUNDARIES, ANNEX5, ANNEX5_URL, ANNEX9_CHECKED, ANNEX9_ITEM, ANNEX9_URL, annex9Lookup, sigunguIsSplit, splitFull, zoneOf, zoneOfFull } from "./annex.mjs";
import { BJD_CSV, BJD_LABEL, COAST_DBF, COAST_SHP, COVERAGE_DIR, MOF_XLSX, REGIONS, SIGUNGU_ALIAS, emdPaths, gisLabel, regionArg, sha256, sigunguMatches, verifyPinnedSources } from "./regions.mjs"; // sha256: 고정 해시 대조 때 계산한 값 재사용

const HERE = dirname(fileURLToPath(import.meta.url));
verifyPinnedSources(); // 원자료가 data-sources.json 고정 해시와 다르면 판정·생성하지 않음
const DRY = process.argv.includes("--dry");
const TARGET_REGIONS = regionArg(); // --region 강원(기본)·전국 등
const nowKst = () => new Date(Date.now() + 9 * 3600e3).toISOString().replace(/\.\d+Z$/, "+09:00");
const CHECKED_AT = nowKst();
const m1 = (x) => Math.round(x * 10) / 10;

// ── 판정 기준값 (아키텍처 2.2 결정 4-A) ──
const INSIDE_SNAP_M = 100; // 경계 밖이면 최근접 읍면까지 100m 이하만 인정
const NEIGHBOR_M = 300; // 300m 안 다른 읍면은 L1 비교
const FRONT_SEA_M = 22200; // 12해리 ≈ 22.2km

// ── 근거 원문: annex-tables.json(별표 원문 인용표)에서 읽음 ──
const zoneOfSigungu = (full, emd = null) => zoneOfFull(full, emd);
const COAST_SNAP_M = 500; // 해안선 대표점이 읍면동 경계에서 500m 넘게 떨어지면 먼 선분 규칙(D·2D) 적용 (노션 2.2 10/21)

// ── 원자료 읽기 (저장소 밖 $BARADUN_GIS_DIR, 아키텍처 2.2 10/21) ──
const EMD_SETS = Object.entries(REGIONS).map(([sido, r]) => ({ sido, code: r.code, ...emdPaths(r.code) }));
const SOURCES = {
  emd: {
    name: "브이월드 법정 읍면동 경계 LSMD_ADM_SECT_UMD (해안 시·도 11곳)",
    base_date: "2026-10",
    crs: "EPSG:5186",
    encoding: "cp949",
    files: Object.fromEntries(EMD_SETS.map((e) => [e.sido, { file: e.label, sha256: sha256(e.shp), dbf_sha256: sha256(e.dbf) }])),
  },
  coast: {
    name: "국립해양조사원 2026 해안선",
    url: "https://www.data.go.kr/data/15083948/fileData.do",
    crs: "EPSG:5186",
    encoding: "EUC-KR",
    file: gisLabel("coastline_2026/2026 해안선.shp"),
    sha256: sha256(COAST_SHP),
    dbf_sha256: sha256(COAST_DBF),
  },
  bjd: { name: "국토교통부 법정동코드 2026-09-29", file: BJD_LABEL, sha256: sha256(BJD_CSV) },
};
const emdSourceOf = (sido) => ({ name: SOURCES.emd.name, base_date: "2026-10", crs: "EPSG:5186", sido, ...SOURCES.emd.files[sido] });

// 시군 이름 연결: 브이월드 COL_ADM_SE → 법정동코드 10자리(xxxxx00000)의 이름. 코드끼리 비교하지 않음
const bjdName = new Map(
  new TextDecoder("euc-kr")
    .decode(readFileSync(BJD_CSV))
    .split(/\r?\n/)
    .slice(1)
    .map((l) => l.split(","))
    .filter((r) => r[2] === "존재")
    .map((r) => [r[0], r[1]]),
);
const sigunguOfCol = (col) => {
  const full = bjdName.get(`${col}00000`);
  if (!full) return null;
  const { sido, sigungu } = splitFull(full);
  // 구가 있는 시('경상북도 포항시 남구')는 시 단위 이름으로 묶음
  const parts = full.split(" ");
  const cityFull = parts.length >= 3 && parts[1].endsWith("시") ? parts.slice(0, 2).join(" ") : full;
  return { full: cityFull, name: sigungu, sido };
};

const emds = EMD_SETS.flatMap((set) => {
  const attr = readDbf(set.dbf, "euc-kr");
  const shapes = readShp(set.shp);
  if (attr.length !== shapes.length) throw new Error(`읍면동 shp·dbf 개수 불일치: ${set.sido}`);
  return shapes.map((sh, i) => ({ ...sh, ...attr[i], set: set.sido, sigungu: sigunguOfCol(attr[i].COL_ADM_SE) }));
});
for (const e of emds) if (!e.sigungu) throw new Error(`시군 이름 조회 실패: ${e.COL_ADM_SE}`);
const emdsBySido = new Map(EMD_SETS.map((s) => [s.sido, emds.filter((e) => e.set === s.sido)]));

// ── 해변 좌표 (해수부 수집본, WGS84) ──
const beachesSrc = readCsv("beaches.csv").filter((b) => TARGET_REGIONS.includes(b.sido_nm) && b.lat && b.lon);
const beachPts = beachesSrc.map((b) => {
  const lat = Number(b.lat);
  const lon = Number(b.lon);
  const [x, y] = toEpsg5186(lat, lon);
  const [sx, sy] = toEpsg5186Snyder(lat, lon);
  if (Math.hypot(x - sx, y - sy) > 0.01) throw new Error(`좌표 변환 교차 확인 실패: ${b.sta_nm}`);
  return { key: `${b.gugun_nm}|${b.sta_nm}`, sido: b.sido_nm, sigungu: b.gugun_nm, lat, lon, x, y };
});

// ── 1. L1 판정 ──
function judgeL1(b) {
  const dist = emds
    .filter((e) => bboxDist(b.x, b.y, e.bbox) <= 1000)
    .map((e) => {
      const inside = insidePolygon(b.x, b.y, e.parts);
      return { e, inside, d: inside ? 0 : boundaryDist(b.x, b.y, e.parts) };
    })
    .sort((p, q) => p.d - q.d);
  const containing = dist.filter((p) => p.inside);
  const emdInfo = (p) => {
    const l1 = p.e.sigungu ? annex9Lookup(p.e.sigungu.sido, p.e.sigungu.name, p.e.EMD_NM) : [];
    return {
      emd_cd: p.e.EMD_CD,
      emd_nm: p.e.EMD_NM,
      col_adm_se: p.e.COL_ADM_SE,
      sigungu_name: p.e.sigungu?.full ?? "",
      distance_m: m1(p.d),
      l1_code: l1.length === 1 ? l1[0].code : "",
      l1_row: l1.length === 1 ? l1[0].row : "",
      l1_quote: l1.length === 1 ? l1[0].quote : "",
      l1_lookup: l1.length === 1 ? "FOUND" : l1.length ? "MULTIPLE" : "NOT_IN_ANNEX9",
    };
  };
  const base = {
    method: "COORDINATE_BOUNDARY",
    boundary_source: emdSourceOf(b.sido),
    sigungu_link: { source: SOURCES.bjd, rule: "COL_ADM_SE + '00000' 법정동코드의 이름과 해수부 gugun_nm 이름 대조(코드끼리 비교 안 함)" },
    coords: { lat: b.lat, lon: b.lon, source: "tools/coverage/out/beaches.csv (해수부 해수욕장정보, 2026-10-16 수집)", epsg5186: [m1(b.x), m1(b.y)], transform: "WGS84 → EPSG:5186 Krüger 급수, Snyder 급수 교차 확인 1cm 이내" },
    rule: "아키텍처 2.2 결정 4-A: ① 경계 안 → 그 읍면 ② 밖 100m 이하 → 최근접 ③ 300m 안 다른 읍면은 별표9 L1이 같으면 확정 ④ 다르면 자동 제외",
    annex9: { url: ANNEX9_URL, item: ANNEX9_ITEM, checked_at_kst: ANNEX9_CHECKED },
    checked_at_kst: CHECKED_AT,
  };
  if (containing.length > 1) throw new Error(`읍면동 경계 중첩: ${b.key}`);
  const chosen = containing[0] ?? dist[0];
  if (!chosen) return { ...base, decision: "NO_EMD_WITHIN_1KM", emd: null, neighbors_within_300m: [], result: "EXCLUDED_OVER_100M", reason: "좌표 1km 안에 법정 읍면동 경계 없음" };
  // 별표9에서 시군 전체가 한 구역(해당 시․군)이면 L1은 공식 시군으로 정해짐: 좌표는 그 시군 안(1km 이내)인지만 확인
  const wide = ANNEX.annex9.sigungu[`${b.sido}|${b.sigungu}`];
  if (wide && wide.rows.length === 1 && wide.rows[0].all) {
    const info = emdInfo(chosen);
    const sameSigungu = sigunguMatches(info.sigungu_name, b.sido, b.sigungu);
    const out = { ...base, decision: "SIGUNGU_WIDE", emd: info, neighbors_within_300m: [] };
    if (!sameSigungu)
      return { ...out, result: "EXCLUDED_SIGUNGU_MISMATCH", reason: `최근접 읍면동 ${info.emd_nm}의 시군(${info.sigungu_name})이 해수부 gugun_nm(${b.sigungu})과 다름(좌표 오류 의심)` };
    return { ...out, result: "VERIFIED", l1_code: wide.rows[0].code, reason: `별표9 ${wide.rows[0].name}: ${wide.rows[0].quote} → 시군 전체 한 구역. 좌표 ${containing.length ? "경계 안" : `경계 밖 ${info.distance_m}m`} ${info.emd_nm}(${info.sigungu_name})로 같은 시군 확인` };
  }
  const decision = containing.length ? "INSIDE" : chosen.d <= INSIDE_SNAP_M ? "NEAREST_WITHIN_100M" : "OVER_100M";
  const main = emdInfo(chosen);
  const neighbors = dist.filter((p) => p !== chosen && p.d <= NEIGHBOR_M).map(emdInfo);
  const out = { ...base, decision, emd: main, neighbors_within_300m: neighbors };
  if (decision === "OVER_100M")
    return { ...out, result: "EXCLUDED_OVER_100M", reason: `좌표가 모든 읍면동 경계 밖, 최근접 ${main.emd_nm}(${main.emd_cd})까지 ${main.distance_m}m > 100m` };
  if (!sigunguMatches(main.sigungu_name, b.sido, b.sigungu))
    return { ...out, result: "EXCLUDED_SIGUNGU_MISMATCH", reason: `읍면동 ${main.emd_nm}의 시군(${main.sigungu_name})이 해수부 gugun_nm(${b.sigungu})과 다름` };
  if (main.l1_lookup !== "FOUND")
    return { ...out, result: "EXCLUDED_NOT_IN_ANNEX9", reason: `${main.emd_nm}이 별표9 ${b.sigungu} 행에서 ${main.l1_lookup === "MULTIPLE" ? "두 행 이상" : "찾을 수 없음"}` };
  const split = neighbors.filter((n) => n.l1_code !== main.l1_code);
  if (split.length)
    return {
      ...out,
      result: "EXCLUDED_L1_SPLIT",
      reason: `L1 갈림: ${main.emd_nm} ${main.distance_m}m ${main.l1_row || "L1 없음"}(${main.l1_code || "-"}) / ${split
        .map((n) => `${n.emd_nm} ${n.distance_m}m ${n.l1_row || "별표9 없음"}(${n.l1_code || "-"})`)
        .join(" / ")}`,
    };
  return {
    ...out,
    result: "VERIFIED",
    l1_code: main.l1_code,
    reason: `${decision === "INSIDE" ? "경계 안" : `경계 밖 ${main.distance_m}m(≤100m)`} ${main.emd_nm}(${main.emd_cd}) → 별표9 ${main.l1_row} ${main.l1_code}` +
      (neighbors.length ? `; 300m 안 ${neighbors.map((n) => `${n.emd_nm} ${n.distance_m}m`).join("·")}도 ${main.l1_row}로 같음` : "; 300m 안 다른 읍면 없음"),
  };
}

// ── 2. 관측소 S1 판정 ──
const ctx = loadAssignContext();
const live = JSON.parse(readFileSync(join(COVERAGE_DIR, "responses/metric-matrix.json"), "utf8"));
const liveById = new Map(live.stations.map((s) => [s.stn_id, s]));
const targets = ctx.stations
  .filter((s) => ["B", "C"].includes(s.tp))
  .filter((s) => beachPts.some((b) => haversineKm(b.lat, b.lon, Number(s.lat), Number(s.lon)) <= 20));
const targetPts = targets.flatMap((s) => {
  const l = liveById.get(s.stn_id);
  return [[Number(s.lat), Number(s.lon)], ...(l ? [[l.lat, l.lon]] : [])].map(([la, lo]) => toEpsg5186(la, lo));
});
const coastAttr = readDbf(COAST_DBF, "euc-kr");
const coast = readShp(COAST_SHP, { keep: (bb) => targetPts.some(([x, y]) => bboxDist(x, y, bb) < 2 * FRONT_SEA_M + 5000) });

// 해안선 선분의 시군: SGG_NAM 대신 법정 읍면동 경계(강원 51·경북 47)로 정함 (5차 사용자 해석)
// 반경 안 부분의 중점이 놓인 읍면동, 경계 밖이면 500m 안 최근접 읍면동의 시군. 그보다 멀면 시군 미정
const coastEmds = emds;
const coastIndex = buildPolygonIndex(coastEmds, { cell: COAST_SNAP_M });
const zoneOfEmd = (e) => zoneOfSigungu(e.sigungu.full, e.EMD_NM);
// 별표4 광역 경계(위도선): 관측소와 반대쪽 해안선은 그 관측소 해역 판정에서 뺌 (아키텍처 2.2 '광역 경계는 별표4 문언')
const boundaryLineY = (b, x) => {
  // 위도선을 EPSG:5186 x에서의 y로 근사 (경도 0.01° 간격 선형 보간)
  let prev = null;
  for (let lon = 124; lon <= 132; lon += 0.01) {
    const p = toEpsg5186(b.lat, lon);
    if (prev && p[0] >= x) return prev[1] + ((p[1] - prev[1]) * (x - prev[0])) / (p[0] - prev[0]);
    prev = p;
  }
  return prev[1];
};

function coastStats(lat, lon, sideFilter = null) {
  const [x, y] = toEpsg5186(lat, lon);
  let d = Infinity;
  let nearest = null;
  for (const f of coast)
    for (const part of f.parts)
      for (let i = 1; i < part.length; i++) {
        const s = segDist(x, y, part[i - 1][0], part[i - 1][1], part[i][0], part[i][1]);
        if (s < d) (d = s), (nearest = f);
      }
  const r = 2 * d;
  const bySigungu = new Map();
  const unresolved = { segments: 0, overlap: 0, features: new Set(), max_distance_m: 0, by_sgg_nam: {} };
  const mismatch = { etc: 0, misname: 0, misname_pairs: {}, etc_by_boundary: {} };
  const farSegments = [];
  let total = 0;
  let crossBoundary = 0;
  for (const f of coast) {
    if (bboxDist(x, y, f.bbox) > r) continue;
    const sggNam = coastAttr[f.index].SGG_NAM;
    for (const part of f.parts)
      for (let i = 1; i < part.length; i++) {
        const [ax, ay] = part[i - 1];
        const [bx, by] = part[i];
        if (segDist(x, y, ax, ay, bx, by) > r) continue;
        const mid = clipMidpoint(x, y, r, ax, ay, bx, by);
        if (!mid) continue;
        if (sideFilter && !sideFilter(mid)) {
          crossBoundary++;
          continue;
        }
        total++;
        const loc = coastIndex.locate(mid[0], mid[1]);
        // 원자료 경계 중첩으로 두 시군 안에 동시에 들면 고르지 않고 시군 미정
        const overlapSigungu = new Set((loc.hits ?? []).map((k) => coastEmds[k].sigungu.full));
        if (overlapSigungu.size > 1) {
          unresolved.segments++;
          unresolved.overlap++;
          unresolved.features.add(f.index);
          unresolved.by_sgg_nam[sggNam] = (unresolved.by_sgg_nam[sggNam] ?? 0) + 1;
          continue;
        }
        let far = null;
        if (loc.k < 0) {
          // 먼 선분(10/21 노션 2.2): 가장 가까운 시군까지 D, 반경 2D 안에 다른 앞바다 구역의 시군 경계가 없으면 그 시군으로 확정
          let D = Infinity;
          let nearEmd = null;
          for (const e of coastEmds) {
            if (bboxDist(mid[0], mid[1], e.bbox) >= D) continue;
            const dd = boundaryDist(mid[0], mid[1], e.parts);
            if (dd < D) (D = dd), (nearEmd = e);
          }
          const nearZone = zoneOfEmd(nearEmd);
          const within2D = new Map(); // 시군(읍면 단위 구역) → 최단 거리
          const zoneOfKey = new Map();
          for (const e of coastEmds) {
            if (bboxDist(mid[0], mid[1], e.bbox) > 2 * D) continue;
            const dd = boundaryDist(mid[0], mid[1], e.parts);
            const z = zoneOfEmd(e);
            const k = z === zoneOfSigungu(e.sigungu.full) ? e.sigungu.full : `${e.sigungu.full} ${e.EMD_NM}`;
            if (dd <= 2 * D) within2D.set(k, Math.min(within2D.get(k) ?? Infinity, dd)), zoneOfKey.set(k, z);
          }
          const otherZone = [...within2D.keys()].filter((name) => zoneOfKey.get(name) !== nearZone || nearZone === null);
          const resolved = nearZone !== null && otherZone.length === 0;
          far = {
            coast_record: f.index,
            sgg_nam: sggNam,
            grp_isl: coastAttr[f.index].GRP_ISL,
            point_epsg5186: [m1(mid[0]), m1(mid[1])],
            nearest_sigungu: nearEmd.sigungu.full,
            nearest_zone: nearZone,
            nearest_emd: `${nearEmd.EMD_NM}(${nearEmd.EMD_CD})`,
            D_m: m1(D),
            radius_2D_m: m1(2 * D),
            sigungu_within_2D: [...within2D].map(([name, dd]) => ({ sigungu: name, zone: zoneOfKey.get(name), distance_m: m1(dd) })),
            other_zone_sigungu_within_2D: otherZone,
            result: resolved ? "RESOLVED" : "UNRESOLVED",
          };
          farSegments.push(far);
          unresolved.max_distance_m = Math.max(unresolved.max_distance_m, D);
          if (!resolved) {
            unresolved.segments++;
            unresolved.features.add(f.index);
            unresolved.by_sgg_nam[sggNam] = (unresolved.by_sgg_nam[sggNam] ?? 0) + 1;
            continue;
          }
        }
        const full = far ? far.nearest_sigungu : coastEmds[loc.k].sigungu.full;
        const zone = far ? far.nearest_zone : zoneOfEmd(coastEmds[loc.k]);
        const gk = `${full}|${zone}`;
        const g = bySigungu.get(gk) ?? { sigungu: zone === zoneOfSigungu(full) ? full : `${full}(${zone ?? "구역 미정"} 읍면)`, zone, segments: 0, features: new Set(), inside: 0, snapped: 0, far: 0, max_snap_m: 0 };
        g.segments++;
        g.features.add(f.index);
        if (far) g.far++;
        else if (loc.inside) g.inside++;
        else (g.snapped++), (g.max_snap_m = Math.max(g.max_snap_m, loc.d));
        bySigungu.set(gk, g);
        if (sggNam === "기타") {
          mismatch.etc++;
          mismatch.etc_by_boundary[full] = (mismatch.etc_by_boundary[full] ?? 0) + 1;
        } else if (sggNam !== full) {
          mismatch.misname++;
          const key = `SGG_NAM ${sggNam} → 경계 ${full}`;
          mismatch.misname_pairs[key] = (mismatch.misname_pairs[key] ?? 0) + 1;
        }
      }
  }
  const sigungu = [...bySigungu.values()]
    .sort((a, b) => b.segments - a.segments)
    .map((g) => ({ ...g, features: g.features.size, max_snap_m: m1(g.max_snap_m) }));
  return {
    epsg5186: [m1(x), m1(y)],
    d_m: m1(d),
    nearest_sgg_nam: coastAttr[nearest.index].SGG_NAM,
    radius_m: m1(r),
    segments_in_radius: total,
    segments_other_side_of_annex4_boundary: crossBoundary,
    sigungu,
    unresolved: { segments: unresolved.segments, overlap: unresolved.overlap, features: unresolved.features.size, by_sgg_nam: unresolved.by_sgg_nam },
    far_segments: farSegments,
    far_summary: { segments: farSegments.length, resolved: farSegments.filter((x) => x.result === "RESOLVED").length, max_D_m: m1(unresolved.max_distance_m) },
    sgg_nam_mismatch: mismatch,
  };
}
const fmtSigungu = (st) => st.sigungu.map((g) => `${g.sigungu} ${g.features}개체·${g.segments}선분`).join(", ");
function judgeStation(s) {
  const l = liveById.get(s.stn_id);
  const coordsSets = [{ label: "catalog", lat: Number(s.lat), lon: Number(s.lon), source: "tools/coverage/out/stations.csv" }];
  if (l && (l.lat !== Number(s.lat) || l.lon !== Number(s.lon)))
    coordsSets.push({ label: "live_sea_obs", lat: l.lat, lon: l.lon, source: "responses/sea_obs-attempt-1.txt (3차 저장본)" });
  const runs = coordsSets.map((c) => {
    // 별표4 광역 경계(위도선)가 걸리는 동해안: 관측소와 같은 쪽 해안선만 셈 (아키텍처 2.2 '광역 경계는 별표4 문언')
    const sides = ANNEX4_BOUNDARIES.filter((bd) => c.lon >= (bd.min_lon ?? 128.5) && Math.abs(c.lat - bd.lat) <= (bd.lat_window ?? 0.5)).map((bd) => ({ bd, north: c.lat >= bd.lat }));
    const sideFilter = sides.length ? (mid) => sides.every(({ bd, north }) => mid[1] >= boundaryLineY(bd, mid[0]) === north) : null;
    const st = coastStats(c.lat, c.lon, sideFilter);
    const zones = [...new Set(st.sigungu.map((g) => g.zone))];
    const inFront = st.d_m <= FRONT_SEA_M;
    const notInZones = sides.filter((x) => !x.north).flatMap((x) => x.bd.north_zones);
    const sideText = sides.length
      ? `별표4 ${sides.map(({ bd, north }) => `${bd.quote} ${north ? "북쪽" : "남쪽"}`).join("·")}(반대쪽 해안선 ${st.segments_other_side_of_annex4_boundary}선분 제외)`
      : "별표4 광역 경계 해당 없음";
    let judgment = "UNVERIFIED";
    let reason;
    if (!inFront) reason = `d=${st.d_m}m > 22.2km: 앞바다 안 판정 불가`;
    else if (st.unresolved.segments)
      reason = `반경 2d=${st.radius_m}m 안 선분 ${st.unresolved.segments}개 시군 미정(먼 선분 중 2D 안 다른 앞바다 구역 시군 있음 ${st.unresolved.segments - st.unresolved.overlap}개·경계 중첩 ${st.unresolved.overlap}개, SGG_NAM ${JSON.stringify(st.unresolved.by_sgg_nam)}) (경계 시군: ${fmtSigungu(st)}); ${sideText}`;
    else if (zones.length !== 1 || zones[0] === null)
      reason = `반경 2d=${st.radius_m}m 안 경계 시군이 한 S1 구역으로 모이지 않음: ${st.sigungu.map((g) => `${g.sigungu} ${g.segments}선분(${g.zone ? ANNEX5[g.zone].name : "별표5로 하나로 정해지지 않음"})`).join(", ")}; ${sideText}`;
    else {
      judgment = "VERIFIED";
      reason = `d=${st.d_m}m ≤ 22.2km, 반경 2d=${st.radius_m}m 안 해안선 ${st.segments_in_radius}선분의 경계 시군 ${fmtSigungu(st)} 모두 ${ANNEX5[zones[0]].name}(별표5: ${ANNEX5[zones[0]].quote}), 시군 미정 0선분${st.far_summary.segments ? `(500m 넘는 먼 선분 ${st.far_summary.segments}개는 D 최대 ${st.far_summary.max_D_m}m, 2D 안 다른 앞바다 구역 시군 없어 최근접 시군으로 확정)` : ""}; ${sideText}`;
    }
    // 자기 구역은 못 정해도 광역 경계 남쪽이 확실하면 북쪽 구역은 아님으로 확정
    if (judgment === "UNVERIFIED" && notInZones.length && inFront) {
      judgment = "VERIFIED_NOT_IN_ZONE";
      reason = `${sides.filter((x) => !x.north).map((x) => `위도 ${c.lat}°N < ${x.bd.quote}(${x.bd.lat.toFixed(5)}°N)`).join("·")} → ${notInZones.map((zc) => ANNEX5[zc]?.name ?? zc).join("·")} 구역 아님 (자기 구역 미정 사유: ${reason})`;
    }
    return { ...c, ...st, within_22_2km_front_sea: inFront, annex4_sides: sides.map(({ bd, north }) => ({ id: bd.id, north })), not_in_zones: judgment === "VERIFIED_NOT_IN_ZONE" ? notInZones : [], zone: judgment === "VERIFIED" ? zones[0] : "", judgment, reason };
  });
  const same = runs.every((r) => r.judgment === runs[0].judgment && r.zone === runs[0].zone);
  const judgment = same && runs[0].judgment !== "UNVERIFIED" ? runs[0].judgment : "UNVERIFIED";
  return {
    stn_id: s.stn_id,
    name: s.name,
    tp: s.tp,
    runs,
    judgment,
    zone: judgment === "VERIFIED" ? runs[0].zone : "",
    not_in_zones: judgment === "VERIFIED_NOT_IN_ZONE" ? runs[0].not_in_zones : [],
    reason: judgment !== "UNVERIFIED"
      ? runs.map((r) => `[${r.label}] ${r.reason}`).join(" / ")
      : `미검증: ${runs.map((r) => `[${r.label}] ${r.judgment === "UNVERIFIED" ? r.reason : `${r.judgment} ${r.zone} — 좌표 묶음 간 판정 불일치`}`).join(" / ")}`,
  };
}

const l1 = new Map(beachPts.map((b) => [b.key, judgeL1(b)]));
const st = targets.map(judgeStation);

// ── 요약 출력 ──
const count = (arr, f) => arr.reduce((m, x) => m.set(f(x), (m.get(f(x)) ?? 0) + 1), new Map());
console.log(`해변 ${beachPts.length}곳 L1:`, Object.fromEntries(count([...l1.values()], (r) => r.result)));
console.log(`  결정 방식:`, Object.fromEntries(count([...l1.values()], (r) => r.decision)));
for (const [k, r] of l1) if (r.result !== "VERIFIED") console.log(`  ${k}: ${r.result} — ${r.reason}`);
console.log(`관측소 ${st.length}곳:`);
for (const s of st)
  console.log(`  ${s.stn_id} ${s.name}(${s.tp}): ${s.judgment} ${s.zone} | ${s.runs
    .map((r) => `${r.label} d=${r.d_m}m r=${r.radius_m}m 선분=${r.segments_in_radius} [${r.sigungu.map((g) => `${g.sigungu}:${g.features}/${g.segments}(안${g.inside}·근접${g.snapped}·먼${g.far},최대${g.max_snap_m}m)`).join(", ")}] 먼선분=${r.far_summary.segments}(확정${r.far_summary.resolved},D최대${r.far_summary.max_D_m}m) 미정=${r.unresolved.segments}(${JSON.stringify(r.unresolved.by_sgg_nam)}) 기타→경계=${r.sgg_nam_mismatch.etc} 이름다름=${r.sgg_nam_mismatch.misname} ${JSON.stringify(r.sgg_nam_mismatch.misname_pairs)}`)
    .join(" ; ")}`);

// ── 공식 주소 연결과 L1 대조 (노션 2.2 'L1 근거 순서' 10/21) ──
// 출처: 해수부 해양레저관광과 '2026 해수욕장 주요 현황'(2026-08-11). 4행부터 연번·광역시도·관리청·해수욕장명·주소·개장/미개장·개장일·폐장일
const MOF_SOURCE = {
  name: "해양수산부 해양레저관광과 '2026 해수욕장 주요 현황' 첨부 '2026 해수욕장 지정 및 개장현황_1.xlsx'",
  posted: "2026-08-11",
  url: "https://www.mof.go.kr/doc/ko/selectDoc.do?menuSeq=427&bbsSeq=2&docSeq=67910",
  file: "$BARADUN_MOF_XLSX(기본 ~/data/2026_해수욕장_현황_해수부.xlsx)",
  sha256: sha256(MOF_XLSX),
};
const excelDate = (v) => (/^\d+$/.test(v ?? "") ? new Date(Date.UTC(1899, 11, 30) + Number(v) * 864e5).toISOString().slice(0, 10) : null);
const mofRows = readFirstSheet(MOF_XLSX)
  .filter((r) => r.row >= 4 && r.cells.D)
  .map((r) => ({
    row: r.row,
    seq: r.cells.A,
    sido: (r.cells.B ?? "").trim(),
    sigungu: (r.cells.C ?? "").replace(/\s+/g, ""),
    name: r.cells.D.trim(),
    address: (r.cells.E ?? "").replace(/\s+/g, " ").trim(),
    openStatus: (r.cells.F ?? "").trim(),
    openDate: excelDate(r.cells.G),
    closeDate: excelDate(r.cells.H),
  }));
// 시군 이름 바뀐 곳: 수집본 시군 → 2026 현황 관리청 후보 (인천 중구 → 영종구)
const nameMap = JSON.parse(readFileSync(join(HERE, "name-map-2026.json"), "utf8"));
const mapByKey = new Map(nameMap.entries.map((x) => [x.key, x]));
// 규칙 ②: 괄호 안·'해수욕장'·'해변'·'리'·'진'만 다른 이름
const normName = (s) => s.replace(/\([^)]*\)/g, "").replace(/해수욕장|해변|리|진/g, "").replace(/\s+/g, "");

function linkOfficial(src) {
  const sigungus = SIGUNGU_ALIAS[`${src.sido_nm}|${src.gugun_nm}`] ?? [src.gugun_nm];
  const pool = mofRows.filter((r) => r.sido === src.sido_nm && sigungus.includes(r.sigungu));
  const pick = (method, list, basis) =>
    list.length === 1 ? { method, row: list[0], basis } : { method: "UNLINKED", candidates: list.map((r) => `${r.name}(${r.row}행)`), basis: `${basis}: 후보 ${list.length}개` };
  const exact = pool.filter((r) => r.name === src.sta_nm);
  if (exact.length) return pick("EXACT", exact, "이름 완전 일치");
  const rule = pool.filter((r) => normName(r.name) === normName(src.sta_nm));
  if (rule.length) return pick("RULE", rule, `괄호·'해변'·'리'·'진' 차이만(${src.sta_nm} ↔ ${rule.map((r) => r.name).join("·")})`);
  const m = mapByKey.get(`${src.sido_nm}|${src.gugun_nm}|${src.sta_nm}`);
  if (m) return pick("MAP", pool.filter((r) => r.name === m.xlsx_name), `대응표 name-map-2026.json: ${m.basis}`);
  return { method: "UNLINKED", candidates: [], basis: "같은 시군에 이름 완전 일치·규칙 일치·대응표 항목 없음" };
}
const srcRows = readCsv("beaches.csv").filter((b) => TARGET_REGIONS.includes(b.sido_nm));
const links = new Map(srcRows.map((b) => [`${b.gugun_nm}|${b.sta_nm}`, linkOfficial(b)]));
if (links.size !== srcRows.length) throw new Error("해변 키(시군|이름) 중복: 시·도를 넘어 같은 키가 있음");
// 한 행이 두 해변에 연결되면 둘 다 연결하지 않음
const rowUse = count([...links.values()].filter((l) => l.row), (l) => l.row.row);
for (const [k, l] of links)
  if (l.row && rowUse.get(l.row.row) > 1) links.set(k, { method: "UNLINKED", candidates: [`${l.row.name}(${l.row.row}행)`], basis: `${l.basis} → 같은 행이 다른 해변에도 연결되어 연결 안 함` });

function addressCheck(key, coord) {
  const link = links.get(key);
  const sigungu = key.split("|")[0];
  const base = { source: MOF_SOURCE, link_method: link.method, link_basis: link.basis };
  if (!link.row) return { ...base, result: "NO_ADDRESS", candidates: link.candidates, reason: `공식 주소 미연결(${link.basis}) → 좌표 판정만 적용` };
  const { row } = link;
  // 주소 앞의 시·도 이름(경남·부산광역시 등)은 건너뛰고 시군 다음 낱말을 읍면·동으로 봄. 도로명만 있으면 읍면 없음
  const tokens = row.address.split(/[\s,]+/);
  const si = tokens.indexOf(sigungu);
  const locality = si >= 0 && /(읍|면|동|가)$/.test(tokens[si + 1] ?? "") ? tokens[si + 1] : "";
  const sido = srcRows.find((b) => `${b.gugun_nm}|${b.sta_nm}` === key)?.sido_nm;
  const l1 = locality ? annex9Lookup(sido, sigungu, locality) : [];
  const addr = {
    ...base,
    xlsx_row: row.row,
    xlsx_seq: row.seq,
    xlsx_name: row.name,
    address: row.address,
    locality,
    l1_code: l1.length === 1 ? l1[0].code : "",
    l1_row: l1.length === 1 ? l1[0].row : "",
    season2026: { status: row.openStatus, openDate: row.openDate, closeDate: row.closeDate },
  };
  const coordL1 = coord.result === "VERIFIED" ? coord.l1_code : "";
  const coordText = coord.result === "VERIFIED" ? `좌표 ${coord.emd.emd_nm} ${coord.emd.distance_m}m → ${coord.emd.l1_row}(${coordL1})` : `좌표 판정 ${coord.result}(${coord.reason})`;
  const addrText = `주소 '${row.address}'(${row.row}행) → ${locality || "읍면동 못 읽음"} → ${addr.l1_row || "별표9 행 없음"}${addr.l1_code ? `(${addr.l1_code})` : ""}`;
  // 좌표 1km 안에 읍면동이 없으면(NO_EMD_WITHIN_1KM, emd: null) 좌표 판정 자체가 자동 제외
  if (!coord.emd) return { ...addr, same_emd_as_coord: false, result: "COORD_EXCLUDED", reason: `${coordText} — 좌표 판정이 자동 제외라 확정 불가. 참고 ${addrText}` };
  addr.same_emd_as_coord = locality === coord.emd.emd_nm;
  if (!locality) return { ...addr, result: "ADDRESS_NO_LOCALITY", reason: `공식 주소 '${row.address}'에서 읍면·동을 읽지 못함(도로명 등) → 좌표 판정만 적용` };
  // 7차(노션 2.2 L1 근거 순서): 좌표 L1 갈림이어도 공식 주소 읍면이 300m 안 좌표 후보 중 하나이고 L1이 같으면 공식 주소로 확정
  if (coord.result === "EXCLUDED_L1_SPLIT") {
    const hit = [coord.emd, ...coord.neighbors_within_300m].find((c) => c.emd_nm === locality && c.l1_code && c.l1_code === addr.l1_code);
    if (hit)
      return {
        ...addr,
        result: "MATCH_SPLIT_CANDIDATE",
        resolved_l1_code: hit.l1_code,
        resolved_l1_row: hit.l1_row,
        resolved_l1_quote: hit.l1_quote,
        reason: `${addrText} = 좌표 후보 ${hit.emd_nm}(${hit.emd_cd}) ${hit.distance_m}m(300m 안) → 공식 주소로 확정. 좌표 판정: ${coord.reason}`,
      };
  }
  if (coord.result !== "VERIFIED") return { ...addr, result: "COORD_EXCLUDED", reason: `${coordText} — 좌표 판정이 자동 제외라 확정 불가. 참고 ${addrText}` };
  if (addr.l1_code && addr.l1_code === coordL1) return { ...addr, result: "MATCH", reason: `${addrText} = ${coordText}` };
  return { ...addr, result: "MISMATCH", reason: `L1 주소↔좌표 불일치: ${addrText} / ${coordText}` };
}
const addrChecks = new Map([...l1].map(([k, r]) => [k, addressCheck(k, r)]));
console.log("공식 주소 연결:", Object.fromEntries(count([...links.values()], (l) => l.method)), "/ L1 대조:", Object.fromEntries(count([...addrChecks.values()], (a) => a.result)));
for (const [k, l] of links) if (l.method === "UNLINKED") console.log(`  미연결 ${k}: ${l.basis} ${l.candidates?.join(", ") ?? ""}`);
for (const [k, a] of addrChecks) if (a.result === "MISMATCH" || (a.result === "COORD_EXCLUDED")) console.log(`  ${a.result} ${k}: ${a.reason}`);

if (DRY) process.exit(0);

// ── 3. 관측소 증거 쓰기 ──
const STATION_PATH = join(COVERAGE_DIR, "station-zone-evidence.json");
const stationDoc = JSON.parse(readFileSync(STATION_PATH, "utf8"));
const RULE_ITEM =
  "예보업무규정(기상청훈령 제1185호) 제6조제3항제1호(앞바다: 기선에서 12해리 안, 동해 문언 기준), 별표4 PDF 4쪽(동해중부해상: 경북·강원 해안경계점 위도선 37°08′47″), 별표5(앞바다 구역별 시군·읍면 관할 해역)";
for (const s of st) {
  let row = stationDoc.stations.find((r) => r.stn_id === s.stn_id);
  if (!row) {
    // 전국 확장: 수집본 관측소(B·C) 중 증거 행이 없던 곳은 새 행
    const src = ctx.stations.find((x) => x.stn_id === s.stn_id);
    row = { stn_id: s.stn_id, name: s.name, lat: src.lat, lon: src.lon, zone: "", status: "UNVERIFIED" };
    stationDoc.stations.push(row);
  }
  // 실응답(저장본) 지표 상태를 증거 행에 기록
  const lv = liveById.get(s.stn_id);
  if (lv) {
    row.metrics ??= {};
    for (const [metric, m] of Object.entries(lv.metrics)) row.metrics[metric] = { ...(row.metrics[metric] ?? {}), live_state: m.state, observed_at_utc: m.observed_at_utc, source: m.source, response_file: m.response_file, response_sha256: m.response_sha256 };
  }
  row.status = s.judgment;
  row.zone = s.zone;
  row.boundary_source_url = SOURCES.coast.url;
  row.boundary_source = { ...SOURCES.coast, sigungu_by: [SOURCES.emd, SOURCES.bjd] };
  row.boundary_rule_item = RULE_ITEM;
  row.boundary_rule_url = ANNEX5_URL;
  row.checked_at_kst = CHECKED_AT;
  row.basis = `${s.judgment === "VERIFIED" ? `${ANNEX5[s.zone].name}(${s.zone}) VERIFIED` : s.judgment === "VERIFIED_NOT_IN_ZONE" ? "VERIFIED_NOT_IN_ZONE(강원 앞바다 구역 아님, 별표4 광역 경계)" : "UNVERIFIED(사람 검토 아님, 결정 4-A)"}: ${s.reason}. 우리 검증 기준(기상청 규칙 아님, 운영 경계 자료 확보 시 그것이 우선)`;
  row.review_required = false;
  if (s.judgment === "VERIFIED_NOT_IN_ZONE") row.not_in_zones = [...s.not_in_zones];
  else delete row.not_in_zones;
  delete row.required_material;
  row.s1_evaluation = {
    ...row.s1_evaluation,
    method: "COASTLINE_D_2D (아키텍처 2.2: d ≤ 22.2km 앞바다 안, 반경 2d 해안선 시군이 모두 같은 별표5 구역이면 VERIFIED; 별표4 37°08′47″ 남쪽은 VERIFIED_NOT_IN_ZONE)",
    coast_sigungu_rule: "5차 사용자 해석: 선분 시군은 SGG_NAM이 아니라 반경 안 부분 중점이 놓인 법정 읍면동(강원 51·경북 47)의 시군, 경계 밖이면 500m 안 최근접 읍면동, 500m 초과·경계 중첩으로 시군이 갈리면 시군 미정 → 하나라도 있으면 미검증",
    coastline_distance_d_km: m1(s.runs[0].d_m / 100) / 10,
    within_22_2km_front_sea: s.runs[0].within_22_2km_front_sea,
    sigungu_within_2d_radius: s.runs[0].sigungu,
    runs: s.runs,
    judgment: s.judgment,
    reason: s.reason,
  };
  for (const metric of Object.keys(METRICS)) {
    const m = row.metrics?.[metric];
    if (!m) continue;
    const present = m.live_state === "VALUE_PRESENT";
    m.status = s.judgment === "VERIFIED_NOT_IN_ZONE" ? "NOT_IN_ZONE" : s.judgment === "VERIFIED" && present ? "VERIFIED" : "UNVERIFIED";
    m.reason =
      s.judgment === "VERIFIED_NOT_IN_ZONE"
        ? "강원 앞바다 구역 아님(별표4 광역 경계) → 강원 해변 후보 아님"
        : s.judgment !== "VERIFIED"
        ? "관측소 S1 UNVERIFIED → 배정 불가"
        : present
          ? `관측소 S1 VERIFIED(${s.zone}) + 실응답 값 있음(3차 저장본)`
          : `관측소 S1 VERIFIED(${s.zone})이나 실응답 ${m.live_state} → 이 지표 배정 불가`;
  }
}
stationDoc.note =
  "관측소 좌표–공식 경계 독립 대조 입력. legacy 값은 비교 이력이며 배정에 사용하지 않음. 2026-10-21 5차: 강원 해변 20km 후보 7곳을 국립해양조사원 2026 해안선 d·2d 규칙으로 판정(결정 4-A), 선분 시군은 법정 읍면동 경계(강원·경북)로 정함, 별표4 위도선 남쪽은 VERIFIED_NOT_IN_ZONE. 나머지는 판정 대상 아님(UNVERIFIED 유지)";
if (!DRY) writeFileSync(STATION_PATH, `${JSON.stringify(stationDoc, null, 2)}\n`);

// ── 4. 해변 증거 쓰기 (L1 + 관측소 배정 확정 여부 + 부재 근거) ──
const BEACH_PATH = join(COVERAGE_DIR, "beach-zone-evidence.json");
const beachDoc = JSON.parse(readFileSync(BEACH_PATH, "utf8"));
const ctx2 = loadAssignContext(); // 방금 쓴 관측소 증거로 다시 읽음
const BEACH_CSV_SHA = sha256(join(COVERAGE_DIR, "out/beaches.csv"));
const BEACH_COLLECTED_AT = "2026-10-16T10:55:24+09:00"; // 해수부 해수욕장정보 수집 시각(수집본 기존 기록)
const pwncd = readCsv("warnings/pwncd_360d.csv");
const PWNCD_SHA = sha256(join(COVERAGE_DIR, "out/warnings/pwncd_360d.csv"));
const pwnCount = (code) => pwncd.filter((r) => r.areaCode === code).length;
const pwnFirst = (code) => pwncd.filter((r) => r.areaCode === code).map((r) => r.tmFc).sort()[0] ?? null;
const T3 = ANNEX.annex3_transition;
// 종전 별표3 → 현행 별표9 이행 근거 (강원 기존 기록은 유지)
// 실데이터 추론은 해변 단위: 이 해변의 land_zone 코드 자체가 360일 이력에 있어야 확정(시군의 다른 새 코드로 대신하지 않음)
function transitionFor(sido, sigungu, landZone) {
  const t = T3.sigungu[`${sido}|${sigungu}`];
  const base = { previous_url: T3.previous_url, previous_rule_item: T3.previous_item, current_url: T3.current_url, current_rule_item: ANNEX9_ITEM, checked_at_kst: CHECKED_AT, previous_quote: t?.previous_quote, current_quote: t?.current_quote, note: t?.note };
  if (!t) return { ...base, status: "NOT_COMPARED", basis: "종전 별표3 대조표에 이 시군 없음" };
  if (t.status === "MATCH") return { ...base, status: "MATCH", basis: "종전 별표3과 현행 별표9의 해당 행 문언이 같음(원문 대조)" };
  const fresh = t.new_codes.map((c) => ({ code: c, count: pwnCount(c), first_tmFc: pwnFirst(c) }));
  const stale = t.old_codes.map((c) => ({ code: c, count: pwnCount(c) }));
  const own = fresh.find((x) => x.code === landZone);
  const ok = Boolean(own && own.count > 0) && stale.every((x) => x.count === 0);
  const ownText = !landZone
    ? "이 해변 L1 코드 없음"
    : own
      ? `이 해변 L1 ${landZone} ${own.count}건`
      : `이 해변 L1 ${landZone}은 현행 별표9 세부 구역 코드 목록에 없음`;
  return {
    ...base,
    status: ok ? "EMPIRICAL_RESOLVED" : "UNRESOLVED",
    empirical_source_file: "tools/coverage/out/warnings/pwncd_360d.csv",
    empirical_source_sha256: PWNCD_SHA,
    land_code: landZone || null,
    new_codes: fresh,
    old_codes: stale,
    basis: `pwncd_360d.csv에서 현행 별표9 세부 구역 코드 ${fresh.map((x) => `${x.code} ${x.count}건${x.first_tmFc ? `(첫 발표 ${x.first_tmFc})` : ""}`).join("·")}, 종전 구역 코드 ${stale.length ? stale.map((x) => `${x.code} ${x.count}건`).join("·") : "현행 코드표에 없음(폐지)"}; ${ownText} → ${ok ? "현행 별표9로 발표되는 것으로 봄" : "확인 안 됨"}(실데이터 추론, 기상청 문서 확인 아님)`,
  };
}
// 앞바다 S1: 시군이 읍면으로 나뉘지 않으면 gugun_nm, 나뉘면 공식 주소 읍면과 좌표 읍면이 같은 구역일 때만
function seaFor(src, r, addr) {
  const split = sigunguIsSplit(src.sido_nm, src.gugun_nm);
  const source = { file: "tools/coverage/out/beaches.csv", sha256: BEACH_CSV_SHA, publisher: "해양수산부", field: "gugun_nm", value: src.gugun_nm, source_name: src.sta_nm, collected_at_kst: BEACH_COLLECTED_AT, checked_at_kst: CHECKED_AT };
  const coordOk = r && !["EXCLUDED_SIGUNGU_MISMATCH", "EXCLUDED_OVER_100M"].includes(r.result);
  const out = { sea_source: source, sea_rule_url: ANNEX5_URL, sea_checked_at_kst: CHECKED_AT, sea_coordinate_review: coordOk ? "NO_SUSPECTED_CONFLICT" : "COORDINATE_OUTSIDE_SIGUNGU" };
  if (!coordOk) return { ...out, sea_zone: "", sea_status: "UNVERIFIED", sea_rule_item: "별표5", sea_basis: `자동 제외(결정 4-A): 좌표 판정 ${r?.result ?? "없음"} — 좌표가 해수부 시군(${src.gugun_nm}) 밖이거나 경계에서 멂(좌표 오류 의심)` };
  if (!split) {
    const zc = zoneOf(src.sido_nm, src.gugun_nm);
    if (!zc) return { ...out, sea_zone: "", sea_status: "UNVERIFIED", sea_rule_item: "별표5", sea_basis: `별표5에서 ${src.sido_nm} ${src.gugun_nm}의 앞바다 구역을 찾지 못함` };
    return { ...out, sea_zone: zc, sea_status: "VERIFIED", sea_rule_item: `예보업무규정 제1185호 별표5(제6조제2항제4호) ${ANNEX5[zc].name}; 제6조제3항제1호`, sea_basis: `해수부 공식 수집본 gugun_nm=${src.gugun_nm} → 별표5 ${ANNEX5[zc].name}: ${ANNEX5[zc].quote}` };
  }
  const zCoord = r?.emd ? zoneOf(src.sido_nm, src.gugun_nm, r.emd.emd_nm) : null;
  const zAddr = addr?.locality ? zoneOf(src.sido_nm, src.gugun_nm, addr.locality) : null;
  const both = zCoord && zAddr && zCoord === zAddr;
  const addrPart = addr?.locality ? `공식 주소 읍면 ${addr.locality} → ${zAddr ? ANNEX5[zAddr].name : "하나로 안 정해짐"}` : "공식 주소 읍면 없음";
  const coordPart = r?.emd ? `좌표 읍면 ${r.emd.emd_nm} → ${zCoord ? ANNEX5[zCoord].name : "하나로 안 정해짐"}` : "좌표 읍면 없음";
  if (!both) return { ...out, sea_zone: "", sea_status: "UNVERIFIED", sea_emd: null, sea_rule_item: "별표5(읍면 단위로 나뉘는 시군)", sea_basis: `자동 제외(결정 4-A): ${src.gugun_nm}은 별표5에서 읍면 단위로 나뉨. ${addrPart}, ${coordPart}` };
  return { ...out, sea_zone: zAddr, sea_status: "VERIFIED", sea_emd: addr.locality, sea_rule_item: `예보업무규정 제1185호 별표5(제6조제2항제4호) ${ANNEX5[zAddr].name}; 제6조제3항제1호`, sea_basis: `별표5 ${ANNEX5[zAddr].name}: ${ANNEX5[zAddr].quote}. ${addrPart}, ${coordPart}(일치)` };
}
for (const src of srcRows) {
  const key = `${src.gugun_nm}|${src.sta_nm}`;
  let e = beachDoc.beaches.find((x) => x.key === key);
  if (!e) {
    // 3차의 관광 사이트 주소 칸은 쓰지 않음(공식 주소는 official_address_2026)
    e = { key, sido: src.sido_nm, official_address: "", address_source_url: "", address_checked_at_kst: "", address_status: "UNVERIFIED", legacy_land_basis: "" };
    beachDoc.beaches.push(e);
  }
  e.sido = src.sido_nm;
  if (src.sido_nm !== "강원") {
    // 강원 행은 3차까지의 기존 S1·이행 기록 유지, 그 밖 시·도는 이번에 원문 인용표로 생성
    Object.assign(e, seaFor(src, l1.get(key), addrChecks.get(key)));
  }
}
const targetKeys = new Set(srcRows.map((b) => `${b.gugun_nm}|${b.sta_nm}`));
for (const e of beachDoc.beaches) {
  if (!targetKeys.has(e.key)) continue; // 이번 --region 밖 해변은 건드리지 않음
  const r = l1.get(e.key);
  const link = links.get(e.key);
  e.official_address_2026 = link.row
    ? { source: MOF_SOURCE, method: link.method, basis: link.basis, xlsx_row: link.row.row, xlsx_name: link.row.name, address: link.row.address, season2026: { status: link.row.openStatus, openDate: link.row.openDate, closeDate: link.row.closeDate } }
    : { source: MOF_SOURCE, method: "UNLINKED", basis: link.basis, candidates: link.candidates };
  if (!r) {
    // 좌표 보류 3곳: 좌표–경계 판정 불가 → 주소 기반 이전 판정은 쓰지 않음
    e.land_status = "UNVERIFIED";
    e.land_zone = "";
    e.land_basis = "좌표 보류(해수부 수집본 좌표 없음) → 좌표–법정 읍면동 경계 판정 불가(결정 4-A). 주소 기반 이전 판정은 사용하지 않음";
    e.land_checked_at_kst = CHECKED_AT;
    delete e.land_proof;
    if (e.sido !== "강원") e.land_transition_comparison = transitionFor(e.sido, e.key.split("|")[0], "");
    continue;
  }
  const addr = addrChecks.get(e.key);
  e.land_proof = { ...r, address_check: addr };
  e.land_checked_at_kst = CHECKED_AT;
  e.land_rule_url = ANNEX9_URL;
  e.land_rule_item = `${ANNEX9_ITEM} — ${r.emd?.l1_row || "해당 행 없음"}`;
  if (addr.result === "MATCH_SPLIT_CANDIDATE") {
    e.land_status = "VERIFIED";
    e.land_zone = addr.resolved_l1_code;
    e.land_rule_item = `${ANNEX9_ITEM} — ${addr.resolved_l1_row}`;
    e.land_basis = `공식 주소 ① + 좌표 후보 ② 일치(노션 2.2 L1 근거 순서, 7차): ${addr.reason}. 원문: ${addr.resolved_l1_quote}`;
  } else if (r.result === "VERIFIED" && addr.result !== "MISMATCH") {
    e.land_status = "VERIFIED";
    e.land_zone = r.l1_code;
    e.land_basis = `${addr.result === "MATCH" ? `공식 주소 ① + 좌표 ② 일치: ${addr.reason}` : `공식 주소 미연결 → 좌표 판정만: ${addr.reason}`}. 좌표–법정 읍면동 경계 판정(결정 4-A): ${r.reason}. 원문: ${r.emd.l1_quote}`;
  } else if (r.result === "VERIFIED") {
    e.land_status = "UNVERIFIED";
    e.land_zone = "";
    e.land_basis = `자동 제외(노션 2.2 L1 근거 순서): ${addr.reason}`;
  } else {
    e.land_status = "UNVERIFIED";
    e.land_zone = ""; // 근거 없는 값은 비움
    e.land_basis = `자동 제외(결정 4-A): ${r.reason}`;
  }
  // 이행 근거(강원 밖): 이 해변 land_zone 코드로 판정. 확인 안 되면 L1 미검증 → 자동 제외
  let transitionExclusion = null;
  if (e.sido !== "강원") {
    e.land_transition_comparison = transitionFor(e.sido, e.key.split("|")[0], e.land_zone);
    const cmp = e.land_transition_comparison;
    if (e.land_status === "VERIFIED" && !["MATCH", "EMPIRICAL_RESOLVED"].includes(cmp.status)) {
      transitionExclusion = { type: "L1_TRANSITION_UNVERIFIED", reason: `종전 별표3 → 현행 별표9 이행 확인 안 됨(${cmp.status}): ${cmp.basis}` };
      e.land_status = "UNVERIFIED";
      e.land_zone = "";
      e.land_basis = `자동 제외(결정 4-A): ${transitionExclusion.reason}`;
    }
  }
  // 주소 기반 이전 판정과 비교만 기록 (판정에는 쓰지 않음)
  if (e.official_locality && r.emd) e.land_proof.address_comparison = { official_locality: e.official_locality, same_emd: e.official_locality === r.emd.emd_nm };

  const seaVerified = zoneProofVerified(e, "sea", e.key.split("|")[0]);
  const b = beachPts.find((p) => p.key === e.key);
  const exclusions = [];
  if (addr.result === "MATCH_SPLIT_CANDIDATE");
  else if (r.decision === "NO_EMD_WITHIN_1KM") exclusions.push({ type: "L1_NO_EMD_WITHIN_1KM", reason: r.reason });
  else if (r.result === "EXCLUDED_L1_SPLIT") exclusions.push({ type: "L1_SPLIT", reason: r.reason });
  else if (r.result === "EXCLUDED_OVER_100M") exclusions.push({ type: "L1_OVER_100M", reason: r.reason });
  else if (r.result !== "VERIFIED") exclusions.push({ type: r.result.replace("EXCLUDED_", "L1_"), reason: r.reason });
  else if (addr.result === "MISMATCH") exclusions.push({ type: "L1_ADDRESS_MISMATCH", reason: addr.reason });
  if (transitionExclusion) exclusions.push(transitionExclusion);
  // 7차(결정 기록 11장 10/21 ⑧): 2026 지정 목록에 후보조차 없는 해변은 출시 제외. 후보가 둘 이상인 미연결은 지정 목록 안이므로 유지
  if (link.method === "UNLINKED" && !link.candidates?.length)
    exclusions.push({ type: "NOT_DESIGNATED_2026", reason: `해수부 '2026 해수욕장 주요 현황' 지정 목록에 연결 후보 없음(${link.basis})` });
  e.station_absence = {};
  const undetermined = [];
  for (const metric of Object.keys(METRICS)) {
    const a = assignMetric(ctx2, { lat: b.lat, lng: b.lon, seaZone: e.sea_zone, seaVerified }, metric);
    if (a.state === "ABSENT")
      e.station_absence[metric] = {
        status: "VERIFIED",
        basis: `${a.reason}. 20km 안 후보: ${a.list.map((c) => `${c.s.stn_id} ${c.s.name}(${c.s.tp}) ${round1(c.km)}km`).join(" / ") || "없음"}; 제외 사유: ${a.skipped.join(" / ") || "없음"}`,
        checked_at_kst: CHECKED_AT,
      };
    if (a.state === "UNDETERMINED") undetermined.push(`${metric}: ${a.reason}`);
  }
  if (!Object.keys(e.station_absence).length) delete e.station_absence;
  if (undetermined.length) exclusions.push({ type: "STATION_UNVERIFIED", reason: undetermined.join(" / ") });
  if (exclusions.length) e.release_exclusion = { checked_at_kst: CHECKED_AT, rule: "아키텍처 2.2 결정 4-A 자동 제외(사람 검토 아님)", items: exclusions };
  else delete e.release_exclusion;
}
beachDoc.note =
  "2026-10-21 4~7차(결정 4-A, 노션 2.2 L1 근거 순서, 7차: 좌표 후보 중 공식 주소와 같은 L1이면 확정·지정 목록 밖 제외): L1은 ① 해수부 '2026 해수욕장 주요 현황' 공식 주소의 읍면·법정동 → 현행 별표9, ② 해수부 좌표와 브이월드 법정 읍면동 경계(2026-10, EPSG:5186) 판정과 비교해 같으면 확정·다르면 자동 제외, 주소 미연결이면 ②만. official_locality(관광 사이트 주소)는 3차 비교 기록. S1은 해수부 gugun_nm 인정(3차 유지). 판정 불가 해변은 release_exclusion에 사유 기록";
beachDoc.land_spatial_sources = SOURCES;
writeFileSync(BEACH_PATH, `${JSON.stringify(beachDoc, null, 2)}\n`);
console.log("증거 파일 갱신 완료");
