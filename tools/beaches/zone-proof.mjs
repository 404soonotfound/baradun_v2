// 해수부 공식 시군 수집본 및 구역 검증 근거의 공통 검사 (강원 파일럿 → 전국)
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ANNEX9_URL as ANNEX9_URL_TABLE, zoneOf } from "./annex.mjs";
import { COVERAGE_DIR, REGIONS, emdPaths, sha256, sigunguMatches } from "./regions.mjs";

// 근거에 남기는 출처 표기는 수집 당시 위치(tools/coverage/…) 그대로 둠. 실제 파일은 COVERAGE_DIR
export const BEACH_SOURCE_FILE = "tools/coverage/out/beaches.csv";
export const beachSourceHash = createHash("sha256")
  .update(
    readFileSync(join(COVERAGE_DIR, "out/beaches.csv")),
  )
  .digest("hex");
// 강원 6시군(파일럿 기록 호환). 전국은 별표5 인용표(annex-tables.json)로 판정
export const SEA_BY_SIGUNGU = {
  고성군: "S1151100",
  속초시: "S1151100",
  양양군: "S1151100",
  강릉시: "S1151200",
  동해시: "S1151300",
  삼척시: "S1151300",
};

export const WARNING_HISTORY_FILE =
  "tools/coverage/out/warnings/pwncd_360d.csv";
export const warningHistoryHash = createHash("sha256")
  .update(
    readFileSync(
      join(COVERAGE_DIR, "out/warnings/pwncd_360d.csv"),
    ),
  )
  .digest("hex");

// L1 좌표–경계 근거(결정 4-A): 브이월드 법정 읍면동 경계 원자료(저장소 밖 $BARADUN_GIS_DIR). 파일이 없으면 검증 불가
const emdSourceOk = (src) => {
  const r = REGIONS[src?.sido];
  if (!r) return false;
  const pth = emdPaths(r.code);
  return src.file === pth.label && Boolean(sha256(pth.shp)) && src.sha256 === sha256(pth.shp);
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
    emdSourceOk(p.boundary_source) &&
    p.annex9?.url === ANNEX9_URL &&
    p.checked_at_kst;
  // 좌표 판정 확정 + 주소 일치 또는 주소 미연결
  // 별표9 '해당 시․군'(시군 전체 한 구역): 좌표가 같은 시군 1km 안이면 됨
  const wideOk =
    p?.method === "COORDINATE_BOUNDARY" && p.decision === "SIGUNGU_WIDE" && p.result === "VERIFIED" && p.l1_code === e.land_zone &&
    sigunguMatches(p.emd?.sigungu_name, e.sido ?? "강원", sigungu) && p.emd.distance_m <= 1000 && emdSourceOk(p.boundary_source) && p.annex9?.url === ANNEX9_URL && p.checked_at_kst &&
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

export function zoneProofVerified(e, kind, sigungu) {
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
      source.sha256 === beachSourceHash &&
      source.field === "gugun_nm" &&
      source.value === sigungu &&
      source.collected_at_kst &&
      e.key === `${sigungu}|${source.source_name}` &&
      e.sea_zone === (e.sido && e.sido !== "강원" ? zoneOf(e.sido, sigungu, e.sea_emd ?? null) : SEA_BY_SIGUNGU[sigungu]) &&
      e.sea_coordinate_review === "NO_SUSPECTED_CONFLICT",
    );
  }
  const cmp = e.land_transition_comparison;
  const transitionOk =
    cmp?.status === "MATCH" ||
    (cmp?.status === "EMPIRICAL_RESOLVED" &&
      cmp.empirical_source_file === WARNING_HISTORY_FILE &&
      cmp.empirical_source_sha256 === warningHistoryHash &&
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
