// BeachCoverageMatrix와 최종 Beach 목록의 공용 검증 (파일 쓰기 없음).
export function validateCoverage({ beaches, matrix, meta }) {
  const errors = [];
  const fail = (m) => errors.push(m);
  // 같은 id가 두 행 이상이면 근거가 모호하므로 실패(마지막 행만 남기지 않음)
  const idCount = new Map();
  for (const r of matrix) if (r.id) idCount.set(r.id, (idCount.get(r.id) ?? 0) + 1);
  for (const [id, n] of idCount) if (n > 1) fail(`${id}: 매트릭스에 ${n}행(중복)`);
  const byId = new Map(matrix.filter((r) => r.id && idCount.get(r.id) === 1).map((r) => [r.id, r]));
  // 공백뿐인 칸은 빈 칸으로 봄
  const filled = (v) => typeof v === "string" && v.trim() !== "";

  // 1) 공개 해변: 매트릭스 행이 있고 근거 칸이 채워져 있어야 함
  const REQUIRED = ["sea_zone", "sea_basis", "sea_rule_url", "sea_checked_at_kst", "coords_source", "station_basis", "response_check"];
  // 육상 구역 근거: 스쿠버 포인트(dive_point)는 바다 위라 생략 가능(계약 SeaWarningZones), 그 밖은 필수
  const LAND_REQUIRED = ["land_zone", "land_basis", "land_rule_url", "land_checked_at_kst"];
  const METRICS = ["waveHeight", "wavePeriod", "waveDirection", "waterTemp", "wind"];
  // 숨긴 해변(hidden: true): 보류·자동 제외로 바뀌어 숨긴 해변은 2)의 보류·제외 사유 검사로.
  // 매트릭스 행이 아직 공개 단계(SOURCE_CANDIDATE)면 사람이 직접 숨긴 해변(data/beaches/README) → 공개 해변과 같은 근거 검사
  const hiddenList = beaches.filter((b) => b.hidden);
  for (const b of beaches) {
    const r = byId.get(b.id);
    if (r && r.hidden !== String(b.hidden)) fail(`${b.id}: hidden 불일치(${r.hidden} ≠ ${b.hidden})`);
  }
  for (const r of matrix) {
    if (r.id && beaches.some((b) => b.id === r.id)) continue;
    if (r.hidden !== "") fail(`${r.id || r.source_name}: 해변 파일 없는 행의 hidden은 빈 칸이어야 함`);
  }
  for (const b of hiddenList) if (!idCount.has(b.id)) fail(`${b.id}: 숨긴 해변의 매트릭스 행 없음`);
  const checked = beaches.filter((b) => !b.hidden || byId.get(b.id)?.stage === "SOURCE_CANDIDATE");
  for (const b of checked) {
    const r = byId.get(b.id);
    if (!r) {
      if (!idCount.has(b.id)) fail(`${b.id}: 매트릭스 행 없음`);
      continue;
    }
    if (r.stage !== "SOURCE_CANDIDATE") fail(`${b.id}: 매트릭스 단계가 공개 대상 아님(${r.stage})`);
    const needLand = b.kind !== "dive_point" || b.warningZones.land !== undefined;
    for (const c of [...REQUIRED, ...(needLand ? LAND_REQUIRED : [])]) if (!filled(r[c])) fail(`${b.id}: 매트릭스 ${c} 비어 있음`);
    if (r.sea_status !== "검증") fail(`${b.id}: S1 근거 미검증(${r.sea_status})`);
    if (needLand && r.land_status !== "검증") fail(`${b.id}: L1 근거 미검증(${r.land_status})`);
    if (filled(r.exclusion)) fail(`${b.id}: 제외 사유가 있는데 공개됨`);
    if (b.slug !== r.slug) fail(`${b.id}: slug 불일치(${b.slug} ≠ ${r.slug})`);
    if (b.warningZones.sea !== r.sea_zone || (b.warningZones.land ?? "") !== r.land_zone) fail(`${b.id}: 특보구역이 매트릭스 근거와 다름`);
    for (const m of METRICS) {
      const s = b.stations[m];
      const cell = r[`st_${m}`] ?? "";
      if (s && !cell.startsWith(`${s.id} `)) fail(`${b.id} ${m}: 관측소 ${s.id}가 매트릭스 근거(${cell})와 다름`);
      if (!s && cell.trim() !== "null(가까운 관측 없음)") fail(`${b.id} ${m}: null인데 '가까운 관측 없음' 근거 없음(${cell})`);
    }
    const mt = meta.beaches?.[b.id];
    if (!mt) fail(`${b.id}: beach-meta.json 항목 없음`);
    else {
      if (!Array.isArray(mt.aliases)) fail(`${b.id}: 별칭 목록 없음`);
      if (!mt.season || !("2026" in mt.season)) fail(`${b.id}: 2026 운영 기간 칸 없음(없으면 null)`);
      // 운영 상태는 open·closed만. 개장(open)은 개장일·폐장일이 있어야 함(build.mjs seasonStatus와 같은 규칙)
      const s26 = mt.season?.["2026"];
      if (s26 && !["open", "closed"].includes(s26.status)) fail(`${b.id}: 모르는 운영 상태(${s26.status})`);
      if (s26?.status === "open" && (!s26.openDate || !s26.closeDate)) fail(`${b.id}: 개장인데 개장일·폐장일 없음`);
    }
  }
  // 2) 공개되지 않은 행: 보류·자동 제외 사유가 있어야 함
  const ids = new Set(checked.map((b) => b.id));
  for (const r of matrix) {
    if (r.id && ids.has(r.id)) continue;
    if (!["보류", "자동 제외"].includes(r.stage)) fail(`${r.id || r.source_name}: 공개 안 된 행의 단계가 보류·자동 제외 아님(${r.stage})`);
    if (!filled(r.exclusion)) fail(`${r.id || r.source_name}: 보류·제외 사유 없음`);
  }
  // 3) meta에 없는 해변 id
  for (const id of Object.keys(meta.beaches ?? {})) if (!ids.has(id)) fail(`beach-meta.json: 없는 해변 ${id}`);
  // 4) 생성기가 숨긴 해변(_meta.auto_hidden): 숨긴 파일이고 매트릭스가 보류·자동 제외여야 함. 아니면 다음 생성 때 사람이 숨긴 해변이 다시 공개될 수 있음
  for (const id of meta._meta?.auto_hidden ?? []) {
    if (!hiddenList.some((b) => b.id === id)) fail(`beach-meta.json auto_hidden: 숨긴 해변 파일 아님 ${id}`);
    else if (byId.get(id)?.stage === "SOURCE_CANDIDATE") fail(`beach-meta.json auto_hidden: 공개 단계 해변 ${id}`);
  }

  return errors;
}
