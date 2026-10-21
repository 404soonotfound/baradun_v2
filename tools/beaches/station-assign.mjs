// BRD-59 대표 관측소 배정 규칙 공용 모듈 (build.mjs·spatial-judge.mjs 공용)
// 규칙(아키텍처 2.2, 10/21 결정 4-A): 해변 S1 VERIFIED + 관측소 S1 VERIFIED·같은 구역 + 20km 이내 최근접
//   + 72시간 미수신 24시간 미만 + 해당 지표 실응답 값 있음
// null(가까운 관측 없음)은 20km 안 후보가 모두 VERIFIED로 다른 구역이거나 후보가 없을 때만.
// 20km 안 미검증 관측소가 배정·null 확정을 막으면 UNDETERMINED → 출시 자동 제외
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { COVERAGE_DIR } from "./regions.mjs";

const SRC = join(COVERAGE_DIR, "out");

export function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') (cell += '"'), i++;
      else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") row.push(cell), (cell = "");
    else if (c === "\n") row.push(cell), rows.push(row), (row = []), (cell = "");
    else if (c !== "\r") cell += c;
  }
  if (cell || row.length) row.push(cell), rows.push(row);
  const [head, ...body] = rows;
  return body.map((r) => Object.fromEntries(head.map((k, i) => [k, r[i] ?? ""])));
}
export const readCsv = (name) => parseCsv(readFileSync(join(SRC, name), "utf8"));

// 대원거리(haversine), km
export function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const rad = (d) => (d * Math.PI) / 180;
  const h =
    Math.sin(rad(lat2 - lat1) / 2) ** 2 +
    Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(rad(lng2 - lng1) / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
export const round1 = (x) => Math.round(x * 10) / 10;

export const LIMIT_KM = 20; // 대표 측정기 거리 상한 (아키텍처 2.2)
export const MISSING_LIMIT_H = 24; // 72시간 중 미수신 24시간 이상이면 대표 제외 (아키텍처 2.2)
export const EXCLUDED_ALWAYS = { "22460": "다대포: 대표 제외 측정기(아키텍처 2.2)", "22501": "사량도: 대표 제외 측정기(아키텍처 2.2)" };

// 지표별 출처 (결정 기록 11장 B1): 파고·수온·바람 = sea_obs(B·C), 파주기·파향 = kma_buoy
export const METRICS = {
  waveHeight: { source: "sea_obs", field: "wh" },
  waterTemp: { source: "sea_obs", field: "tw" },
  wind: { source: "sea_obs", field: "wh" }, // 바람 72시간 실측 없음 → 파고 수신 기준, 값 유무는 실응답으로 판정
  wavePeriod: { source: "kma_buoy", field: "wp" },
  waveDirection: { source: "kma_buoy", field: "wo" },
};

// 수집본(stations.csv·72시간 실측)·관측소 독립 검증 입력 읽기
export function loadAssignContext() {
  const stations = readCsv("stations.csv");
  const evidence = JSON.parse(readFileSync(join(SRC, "../station-zone-evidence.json"), "utf8")).stations;
  const evidenceById = new Map(evidence.map((s) => [s.stn_id, s]));
  const ok = (v) => v !== "" && v !== undefined && Number(v) > -99;
  const seaObs = readCsv("freshness/sea_obs_72h.csv");
  const seaHours = [...new Set(seaObs.map((r) => r.req_tm))].sort();
  const windowStart = seaHours[0];
  const windowEnd = seaHours.at(-1);
  const buoy = readCsv("freshness/kma_buoy2_7d.csv").filter(
    (r) => r.tm.slice(0, 10) >= windowStart.slice(0, 10) && r.tm.slice(0, 10) <= windowEnd.slice(0, 10),
  );
  // 72시간 실측 미수신 시간: sea_obs는 요청 시각(1시간) 단위, kma_buoy2는 같은 72시간 창의 시(hour) 단위
  const missingHours = (id, field) => {
    if (field === "wh" || field === "tw") {
      const got = new Set(seaObs.filter((r) => r.stn === id && ok(r[field])).map((r) => r.req_tm));
      return seaHours.length - got.size;
    }
    const got = new Set(buoy.filter((r) => r.stn === id && ok(r[field])).map((r) => r.tm.slice(0, 10)));
    return seaHours.length - Math.min(got.size, seaHours.length);
  };
  const candidatesFor = (metric) =>
    stations.filter((s) => {
      if (!["B", "C"].includes(s.tp)) return false; // B1: 부이 B·파고부이 C만
      if (METRICS[metric].source === "kma_buoy" && s.in_kma_buoy !== "True") return false;
      return true;
    });
  return { stations, evidence, evidenceById, missingHours, candidatesFor, windowStart, windowEnd };
}

// 해변 한 곳·지표 하나의 배정 판정
// 반환: { state: ASSIGNED|ABSENT|UNDETERMINED, chosen, km, list, skipped[], blockers[], reason }
export function assignMetric(ctx, beach, metric) {
  const { field } = METRICS[metric];
  const list = ctx
    .candidatesFor(metric)
    .map((s) => ({ s, km: haversineKm(beach.lat, beach.lng, Number(s.lat), Number(s.lon)) }))
    .filter((c) => c.km <= LIMIT_KM)
    .sort((a, b) => a.km - b.km);
  const skipped = [];
  const label = (c) => `${c.s.stn_id} ${c.s.name}(${c.s.tp}) ${round1(c.km)}km`;
  if (!beach.seaVerified)
    return { state: "UNDETERMINED", chosen: null, list, skipped, blockers: [], reason: "해변 S1 미검증" };
  for (const c of list) {
    const id = c.s.stn_id;
    if (EXCLUDED_ALWAYS[id]) {
      skipped.push(`${label(c)}: ${EXCLUDED_ALWAYS[id]}`);
      continue;
    }
    const miss = ctx.missingHours(id, field);
    if (miss >= MISSING_LIMIT_H) {
      skipped.push(`${label(c)}: ${field} 72시간 중 ${miss}시간 미수신`);
      continue;
    }
    const ev = ctx.evidenceById.get(id);
    const live = ev?.metrics?.[metric]?.live_state;
    // 별표4 광역 경계로 강원 앞바다 밖이 확정된 관측소는 같은 구역 후보로 세지 않음
    if (ev?.status === "VERIFIED_NOT_IN_ZONE" && ev.not_in_zones?.includes(beach.seaZone)) {
      skipped.push(`${label(c)}: VERIFIED_NOT_IN_ZONE(${beach.seaZone} 아님)`);
      continue;
    }
    if (ev?.status !== "VERIFIED") {
      // 값이 없다고 확인된 지표만 건너뜀. 값 있음·미확인이면 배정·부재 모두 확정 불가
      if (live && live !== "VALUE_PRESENT") {
        skipped.push(`${label(c)}: S1 미검증이나 실응답 ${live}`);
        continue;
      }
      return {
        state: "UNDETERMINED",
        chosen: null,
        list,
        skipped,
        blockers: [label(c)],
        reason: `20km 안 S1 미검증 관측소 ${label(c)}(실응답 ${live ?? "미확인"})로 배정·부재 확정 불가`,
      };
    }
    if (ev.zone !== beach.seaZone) {
      skipped.push(`${label(c)}: S1 VERIFIED ${ev.zone} ≠ 해변 ${beach.seaZone}`);
      continue;
    }
    if (live !== "VALUE_PRESENT" || ev.metrics?.[metric]?.status !== "VERIFIED") {
      skipped.push(`${label(c)}: 같은 구역이나 실응답 ${live ?? "미확인"}`);
      continue;
    }
    return { state: "ASSIGNED", chosen: c.s, km: c.km, list, skipped, blockers: [], reason: `${label(c)} 배정` };
  }
  return {
    state: "ABSENT",
    chosen: null,
    list,
    skipped,
    blockers: [],
    reason: list.length ? "20km 안 후보가 모두 다른 구역(VERIFIED·VERIFIED_NOT_IN_ZONE)·값 없음·72시간 기준 제외" : "20km 안 B·C 관측소 없음",
  };
}
