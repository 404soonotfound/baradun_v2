// 해수부 공식 시군 수집본 및 구역 검증 근거의 공통 검사 (강원 파일럿 → 전국)
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ANNEX5, ANNEX5_URL, ANNEX9_URL as ANNEX9_URL_TABLE, sigunguIsSplit, zoneOf } from "./annex.mjs";
import { BJD_CSV, BJD_LABEL, COAST_DBF, COAST_SHP, COVERAGE_DIR, MOF_LABEL, MOF_XLSX, REGIONS, emdPaths, gisLabel, pinnedSha, sha256, sigunguMatches } from "./regions.mjs";

// 근거에 남기는 출처 표기는 수집 당시 위치(tools/coverage/…) 그대로 둠. 실제 파일은 COVERAGE_DIR
export const BEACH_SOURCE_FILE = "tools/coverage/out/beaches.csv";
const sourceHash = (coverageDir, path) => createHash("sha256").update(readFileSync(join(coverageDir, path))).digest("hex");

// 전국 공통 S1 근거 생성. 별표5 구역 조회는 annex.mjs의 zoneOf만 사용함.
export function seaEvidenceFor(src, r, addr, { sourceSha, collectedAt, checkedAt }) {
  const split = sigunguIsSplit(src.sido_nm, src.gugun_nm);
  const source = { file: BEACH_SOURCE_FILE, sha256: sourceSha, publisher: "해양수산부", field: "gugun_nm", value: src.gugun_nm, source_name: src.sta_nm, collected_at_kst: collectedAt, checked_at_kst: checkedAt };
  const coordOk = r && !["EXCLUDED_SIGUNGU_MISMATCH", "EXCLUDED_OVER_100M"].includes(r.result);
  const out = { sea_source: source, sea_rule_url: ANNEX5_URL, sea_checked_at_kst: checkedAt, sea_coordinate_review: coordOk ? "NO_SUSPECTED_CONFLICT" : "COORDINATE_OUTSIDE_SIGUNGU" };
  if (!coordOk) return { ...out, sea_zone: "", sea_status: "UNVERIFIED", sea_rule_item: "별표5", sea_basis: `자동 제외(결정 4-A): 좌표 판정 ${r?.result ?? "없음"} — 좌표가 해수부 시군(${src.gugun_nm}) 밖이거나 경계에서 멂(좌표 오류 의심)` };
  if (!split) {
    const zc = zoneOf(src.sido_nm, src.gugun_nm);
    if (!zc) return { ...out, sea_zone: "", sea_status: "UNVERIFIED", sea_rule_item: "별표5", sea_basis: `별표5에서 ${src.sido_nm} ${src.gugun_nm}의 앞바다 구역을 찾지 못함` };
    return { ...out, sea_zone: zc, sea_status: "VERIFIED", sea_rule_item: `예보업무규정 제1185호 별표5(제6조제2항제4호) ${ANNEX5[zc].name}; 제6조제3항제1호`, sea_basis: `해수부 공식 수집본 gugun_nm=${src.gugun_nm} → 별표5 ${ANNEX5[zc].name}: ${ANNEX5[zc].quote}` };
  }
  const zCoord = r?.emd ? zoneOf(src.sido_nm, src.gugun_nm, r.emd.emd_nm) : null;
  const zAddr = addr?.locality_status === "VERIFIED_LOCALITY" ? zoneOf(src.sido_nm, src.gugun_nm, addr.locality) : null;
  const both = zCoord && zAddr && zCoord === zAddr;
  const addrPart = addr?.locality ? `공식 주소 읍면 ${addr.locality} → ${zAddr ? ANNEX5[zAddr].name : "하나로 안 정해짐"}` : "공식 주소 읍면 없음";
  const coordPart = r?.emd ? `좌표 읍면 ${r.emd.emd_nm} → ${zCoord ? ANNEX5[zCoord].name : "하나로 안 정해짐"}` : "좌표 읍면 없음";
  if (!both) return { ...out, sea_zone: "", sea_status: "UNVERIFIED", sea_emd: null, sea_rule_item: "별표5(읍면 단위로 나뉘는 시군)", sea_basis: `자동 제외(결정 4-A): ${src.gugun_nm}은 별표5에서 읍면 단위로 나뉨. ${addrPart}, ${coordPart}` };
  return { ...out, sea_zone: zAddr, sea_status: "VERIFIED", sea_emd: addr.locality, sea_rule_item: `예보업무규정 제1185호 별표5(제6조제2항제4호) ${ANNEX5[zAddr].name}; 제6조제3항제1호`, sea_basis: `별표5 ${ANNEX5[zAddr].name}: ${ANNEX5[zAddr].quote}. ${addrPart}, ${coordPart}(일치)` };
}

export const WARNING_HISTORY_FILE =
  "tools/coverage/out/warnings/pwncd_360d.csv";

// L1 좌표–경계 근거(결정 4-A): 브이월드 법정 읍면동 경계 원자료(저장소 밖 $BARADUN_GIS_DIR). 파일이 없으면 검증 불가
const emdSourceOk = (src) => {
  const r = REGIONS[src?.sido];
  if (!r) return false;
  const pth = emdPaths(r.code);
  // 근거에 기록된 해시 = 지금 파일 = data-sources.json 고정 해시(검토한 원자료). 읍면동 코드·이름은 dbf에 있어 dbf도 대조
  return src.file === pth.label && pinnedOk(src.sha256, pth.shp, pth.label) && pinnedOk(src.dbf_sha256, pth.dbf, pth.label.replace(/\.shp$/, ".dbf"));
};
// 고정 해시가 있고 근거 해시·지금 파일 해시와 모두 같음
const pinnedOk = (recorded, path, label) => Boolean(pinnedSha(label)) && recorded === pinnedSha(label) && recorded === sha256(path);
// 공식 주소 대조 근거(address_check)가 고정 해시 해수부 xlsx에서 나왔는지
const mofSourceOk = (a) => pinnedOk(a?.source?.sha256, MOF_XLSX, MOF_LABEL);
// 시군 이름 연결(법정동코드)도 고정 해시 원자료에서 나왔는지
const bjdSourceOk = (src) => pinnedOk(src?.sha256, BJD_CSV, BJD_LABEL);
// L1 좌표 판정 근거 원자료 전부: 읍면동 경계 + 해수부 주소 xlsx + 법정동코드
const landSourcesOk = (p) => emdSourceOk(p?.boundary_source) && mofSourceOk(p?.address_check) && bjdSourceOk(p?.sigungu_link?.source);
// 관측소 S1 근거(station-zone-evidence boundary_source): 해안선 + 시·도별 읍면동 경계 + 법정동코드가 모두 고정 해시와 같음
export const stationSourceOk = (src) => {
  const coastLabel = gisLabel("coastline_2026/2026 해안선.shp");
  const [emd, bjd] = src?.sigungu_by ?? [];
  const emdFiles = Object.entries(emd?.files ?? {});
  return (
    pinnedOk(src?.sha256, COAST_SHP, coastLabel) &&
    pinnedOk(src?.dbf_sha256, COAST_DBF, coastLabel.replace(/\.shp$/, ".dbf")) &&
    emdFiles.length === Object.keys(REGIONS).length &&
    emdFiles.every(([sido, f]) => emdSourceOk({ sido, ...f })) &&
    bjdSourceOk(bjd)
  );
};
export const ANNEX9_URL = ANNEX9_URL_TABLE;

function landSpatialVerified(e, sigungu) {
  const p = e.land_proof;
  const a = p?.address_check;
  const common =
    p?.method === "COORDINATE_BOUNDARY" &&
    p.emd?.emd_cd &&
    p.emd.emd_nm &&
    sigunguMatches(p.emd.sigungu_name, e.sido ?? "강원", sigungu) &&
    ["INSIDE", "NEAREST_WITHIN_100M"].includes(p.decision) &&
    (p.decision === "INSIDE" || p.emd.distance_m <= 100) &&
    landSourcesOk(p) &&
    p.annex9?.url === ANNEX9_URL &&
    p.checked_at_kst;
  // 좌표 판정 확정 + 주소 일치 또는 주소 미연결
  // 별표9 '해당 시․군'(시군 전체 한 구역): 좌표가 같은 시군 1km 안이면 됨
  const wideOk =
    p?.method === "COORDINATE_BOUNDARY" && p.decision === "SIGUNGU_WIDE" && p.result === "VERIFIED" && p.l1_code === e.land_zone &&
    sigunguMatches(p.emd?.sigungu_name, e.sido ?? "강원", sigungu) && p.emd.distance_m <= 1000 && landSourcesOk(p) && p.annex9?.url === ANNEX9_URL && p.checked_at_kst &&
    (a?.result === "NO_ADDRESS" || a?.result === "ADDRESS_NO_LOCALITY" || (a?.result === "MATCH" && a.l1_code === e.land_zone && a.locality));
  const coordOk =
    p?.result === "VERIFIED" &&
    p.l1_code === e.land_zone &&
    p.emd?.l1_code === e.land_zone &&
    (p.neighbors_within_300m ?? []).every((n) => n.l1_code === e.land_zone) &&
    // L1 근거 순서(노션 2.2 10/21): 공식 주소가 연결되면 주소 L1이 같아야 하고, 미연결이면 좌표 판정만
    (a?.result === "NO_ADDRESS" || a?.result === "ADDRESS_NO_LOCALITY" || (a?.result === "MATCH" && a.l1_code === e.land_zone && a.locality));
  // 7차: 좌표 L1 갈림 + 공식 주소 읍면이 300m 안 좌표 후보 중 하나이고 L1 같음
  const splitOk =
    p?.result === "EXCLUDED_L1_SPLIT" &&
    a?.result === "MATCH_SPLIT_CANDIDATE" &&
    a.locality &&
    a.l1_code === e.land_zone &&
    a.resolved_l1_code === e.land_zone &&
    [p.emd, ...(p.neighbors_within_300m ?? [])].some((c) => c.emd_nm === a.locality && c.l1_code === e.land_zone);
  return Boolean(wideOk || (common && (coordOk || splitOk)));
}

export function zoneProofVerified(e, kind, sigungu, coverageDir = COVERAGE_DIR) {
  if (!(
    e?.[`${kind}_status`] === "VERIFIED" &&
    e[`${kind}_zone`] &&
    e[`${kind}_rule_url`] &&
    e[`${kind}_rule_item`] &&
    e[`${kind}_basis`] &&
    e[`${kind}_checked_at_kst`]
  ))
    return false;
  if (kind === "sea") {
    const source = e.sea_source;
    return Boolean(
      source?.file === BEACH_SOURCE_FILE &&
      source.sha256 === sourceHash(coverageDir, "out/beaches.csv") &&
      source.field === "gugun_nm" &&
      source.value === sigungu &&
      source.collected_at_kst &&
      e.key === `${sigungu}|${source.source_name}` &&
      e.sea_zone === zoneOf(e.sido ?? "강원", sigungu, e.sea_emd ?? null) &&
      e.sea_coordinate_review === "NO_SUSPECTED_CONFLICT",
    );
  }
  const cmp = e.land_transition_comparison;
  const transitionOk =
    cmp?.status === "MATCH" ||
    (cmp?.status === "EMPIRICAL_RESOLVED" &&
      cmp.empirical_source_file === WARNING_HISTORY_FILE &&
      cmp.empirical_source_sha256 === sourceHash(coverageDir, "out/warnings/pwncd_360d.csv") &&
      typeof cmp.basis === "string" &&
      cmp.basis.includes("실데이터 추론, 기상청 문서 확인 아님"));
  // 4차부터 공식 주소 대신 좌표–법정 읍면동 경계로 읍면 결정(공식 주소는 비교 기록만)
  return Boolean(
    landSpatialVerified(e, sigungu) &&
    transitionOk &&
    cmp?.previous_url &&
    cmp?.current_url &&
    cmp?.checked_at_kst,
  );
}
