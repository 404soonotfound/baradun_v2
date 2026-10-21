// BRD-59 공개 매트릭스(data/beach-coverage.csv) 줄인 형태: 해변별 결과 칸만 남김
// 전체 매트릭스(coverage-<지역>.csv)는 tools/beaches에만 둠(커밋 안 함)
// 남기는 칸은 packages/contracts/scripts/check-coverage.mjs의 검사 칸과 맞춤

export const SLIM_COLS = [
  "id", "source_name", "sigungu", "name_ko", "slug", "stage", "lat", "lng", "coast", "coords_source",
  "sea_zone", "sea_status", "sea_basis", "sea_rule_url", "sea_checked_at_kst",
  "land_zone", "land_status", "land_basis", "land_rule_url", "land_checked_at_kst",
  "st_waveHeight", "st_wavePeriod", "st_waveDirection", "st_waterTemp", "st_wind", "station_basis", "response_check",
  "exclusion", "review_reason",
];

// 법령 링크 → 코드. 코드와 링크 대응은 data/beaches/README.md. 모르는 링크는 그대로 둠
const RULE_CODES = {
  "https://www.law.go.kr/LSW/flDownload.do?flSeq=166843467&bylClsCd=200201": "훈령1185-별표5",
  "https://www.law.go.kr/LSW/flDownload.do?flSeq=166843509&bylClsCd=200201": "훈령1185-별표9",
  "https://www.law.go.kr/LSW/flDownload.do?flSeq=166843509": "훈령1185-별표9",
};
const LAND_KINDS = {
  "공식 주소 ① + 좌표 ② 일치": "주소+좌표 일치",
  "공식 주소 미연결 → 좌표 판정만": "좌표만(주소 미연결)",
  "공식 주소 ① + 좌표 후보 ② 일치(노션 2.2 L1 근거 순서, 7차)": "주소+좌표 후보 일치",
};
const METRIC_KO = { waveHeight: "파고", wavePeriod: "파주기", waveDirection: "파향", waterTemp: "수온", wind: "바람" };
const SHORT_TEXT = [
  ["해수부 해수욕장정보 API(2026-10-16 수집)", "해수부 해수욕장정보 API 2026-10-16"],
  ["실응답 3차 저장본 재사용(2026-10-20T15:00:00Z, sea_obs·kma_buoy HTTP 200, 새 호출 없음)", "실응답 3차 2026-10-20T15:00Z HTTP 200"],
];

const str = (v) => (v == null ? "" : String(v));
const shorten = (v) => SHORT_TEXT.reduce((s, [from, to]) => (s === from ? to : s), v);

// 'gugun_nm=서구 → 별표5 부산앞바다'. 형식이 다르면(자동 제외 사유 등) 원문 유지
const seaBasis = (r) => {
  const m = r.sea_basis.match(/gugun_nm=(\S+) → (별표\d+ [^:]+)/);
  return m ? `gugun_nm=${m[1]} → ${m[2]}` : r.sea_basis;
};

// '주소+좌표 일치: 암남동(26140124) 21.1m → 부산서부(SIGUNGU_WIDE)'
const landBasis = (r) => {
  const kind = LAND_KINDS[r.land_basis.split(":")[0]];
  const name = (r.land_basis.match(/→ ([^(→]+)\(L\d+\)/)?.[1] ?? r.land_basis.match(/별표9 ([^:\s(]+)/)?.[1])?.trim();
  return kind && r.land_zone && name ? `${kind}: ${r.land_emd} → ${name}(${r.land_decision})` : r.land_basis;
};

// 출처·후보가 같은 지표끼리 묶음: 'sea_obs[22460 8.3km 제외(대표 제외), 22459 10.3km] → 파고 22459, ...; 구역 22459 S1311100 VERIFIED'
const stationBasis = (r) => {
  const excluded = new Map();
  for (const s of r.station_excluded.split(" / ")) {
    const m = s.match(/^(\w+) (\d+) .*?: (.*)$/);
    if (m) excluded.set(m[2], m[3].replace(/^[^:]+: /, "").replace("대표 제외 측정기(아키텍처 2.2)", "대표 제외"));
  }
  const groups = new Map();
  const zones = [];
  for (const s of r.station_basis.split(" ; ")) {
    const m = s.match(/^(\w+)\[(\w+)\]: (.*) → (.*)$/s);
    if (!m) {
      const z = s.match(/^(\d+) 구역: .*?\((\w+)\) (\w+):/);
      zones.push(z ? `${z[1]} ${z[2]} ${z[3]}` : s);
      continue;
    }
    const [, metric, source, cands, result] = m;
    const res = result
      .replace(/^null\(가까운 관측 없음: 20km 안 후보가 모두 다른 구역.*\)$/, "null(다른 구역·값 없음·72h)")
      .replace("null(가까운 관측 없음: 20km 안 B·C 관측소 없음)", "null(20km 안 B·C 없음)")
      .replace(/^확정 불가\(20km 안 S1 미검증 관측소 (\d+) .*\)$/, "확정 불가($1 S1 미검증)");
    const key = `${source}|${cands}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(`${METRIC_KO[metric] ?? metric} ${res}`);
  }
  const parts = [...groups].map(([key, results]) => {
    const [source, cands] = key.split("|");
    const list = cands === "20km 안 후보 없음"
      ? "후보 없음"
      : cands.split(" / ").map((c) => {
          const [id, , km] = c.split(" ");
          return excluded.has(id) ? `${id} ${km} 제외(${excluded.get(id)})` : `${id} ${km}`;
        }).join(", ");
    return `${source}[${list}] → ${results.join(", ")}`;
  });
  return [...parts, ...(zones.length ? [`구역 ${zones.join(", ")}`] : [])].join("; ");
};

export function slimMatrix(rows) {
  return rows.map((row) => {
    const r = Object.fromEntries(Object.entries(row).map(([k, v]) => [k, str(v)]));
    const slim = {
      ...r,
      coords_source: shorten(r.coords_source),
      response_check: shorten(r.response_check),
      sea_basis: seaBasis(r),
      land_basis: landBasis(r),
      station_basis: stationBasis(r),
      sea_rule_url: RULE_CODES[r.sea_rule_url] ?? r.sea_rule_url,
      land_rule_url: RULE_CODES[r.land_rule_url] ?? r.land_rule_url,
    };
    return Object.fromEntries(SLIM_COLS.map((c) => [c, slim[c] ?? ""]));
  });
}
