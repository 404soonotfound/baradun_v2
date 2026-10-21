// BRD-59 해변 초안 검사(--region 강원|전국|<시·도>): 필수 칸·slug 형식·중복·20km 초과 + beach-rules.mjs + 계약 Beach 스키마(ajv)
// ajv는 packages/contracts에 이미 설치된 것만 사용(새로 설치하지 않음)
// 실행: node tools/beaches/check.mjs (저장소 맨 위에서)
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkList } from "../../packages/contracts/scripts/beach-rules.mjs";
import { stationSourceOk, zoneProofVerified } from "./zone-proof.mjs";
import { COVERAGE_DIR, regionArg, regionSlug, verifyPinnedSources } from "./regions.mjs";
import { readCsv } from "./station-assign.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
verifyPinnedSources(); // 원자료가 data-sources.json 고정 해시와 다르면 판정·생성하지 않음
const ROOT = join(HERE, "../..");
const TARGET_REGIONS = regionArg();
const draft = JSON.parse(readFileSync(join(COVERAGE_DIR, `${regionSlug(TARGET_REGIONS)}.json`), "utf8"));
const regionKeys = new Set(readCsv("beaches.csv").filter((b) => TARGET_REGIONS.includes(b.sido_nm)).map((b) => `${b.gugun_nm}|${b.sta_nm}`));
const beaches = draft.beaches;
const holdsAll = JSON.parse(readFileSync(join(HERE, "expected-holds.json"), "utf8"));
const holds = { ...holdsAll, coordinates: holdsAll.coordinates.filter((h) => regionKeys.has(h.key)) }; // 이번 지역 보류만
const slugHolds = new Map(holds.slug.map((h) => [h.id, h]));
let expectedCount = 0;

const SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const REQUIRED = ["id", "slug", "name", "region", "coords", "activities", "hidden", "warningZones", "stations", "photo", "cctv"];
const METRICS = ["waveHeight", "wavePeriod", "waveDirection", "waterTemp", "wind"];
const strip = ({ _draft, ...beach }) => beach; // 계약 밖 검토용 칸 제거
const haversine = (lat1, lng1, lat2, lng2) => {
  const rad = (d) => (d * Math.PI) / 180;
  const h = Math.sin(rad(lat2 - lat1) / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(rad(lng2 - lng1) / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
};

const results = [];
const report = (name, errors) => {
  results.push({ name, errors });
  console.log(`\n[${errors.length ? "실패" : "통과"}] ${name}${errors.length ? ` ${errors.length}건` : ""}`);
  for (const e of errors) console.log(`  - ${e}`);
};

// 명시된 보류 대상·사유와 실제 보류의 일치 검사
{
  const errors = [];
  if (slugHolds.size !== holds.slug.length) errors.push("slug 보류 id 중복");
  const releaseExcluded = new Map((draft._meta.releaseExcluded ?? []).map((x) => [x.id, x]));
  for (const h of holds.slug) {
    const b = beaches.find((item) => item.id === h.id);
    if (!b && releaseExcluded.get(h.id)?.sourceName === h.sourceName) continue; // 출시 자동 제외로 레코드 없음
    if (!h.reason || !b || b.slug !== null || b._draft?.sourceName !== h.sourceName)
      errors.push(`${h.id}: slug 보류 근거·대상 불일치`);
  }
  for (const b of beaches)
    if (b.slug === null && !slugHolds.has(b.id)) errors.push(`${b.id}: 목록에 없는 slug 보류`);
  const source = JSON.parse(readFileSync(join(COVERAGE_DIR, "beach-zone-evidence.json"), "utf8")).beaches;
  if (new Set(holds.coordinates.map((h) => h.key)).size !== holds.coordinates.length) errors.push("좌표 보류 키 중복");
  for (const h of holds.coordinates)
    if (!h.reason || !source.some((r) => r.key === h.key) || beaches.some((b) => `${b.region.sigungu.ko}|${b._draft.sourceName}` === h.key))
      errors.push(`${h.key}: 좌표 보류 근거·대상 불일치`);
  report("명시된 보류 목록", errors);
}

// 1) 필수 칸 누락 및 의도한 slug 보류 구분 검사
{
  const errors = [];
  const deferred = [];
  for (const b of beaches) {
    for (const k of REQUIRED) {
      if (!(k in b)) errors.push(`${b.id}: ${k} 칸 없음`);
      else if (b[k] === null && k === "slug") {
        if (b._draft?.slugStatus === "전국 확정 때 결정") deferred.push(b.id);
        else errors.push(`${b.id}: slug null인데 보류 표시 없음`);
      } else if (b[k] === null && !["photo", "cctv"].includes(k)) errors.push(`${b.id}: ${k} null`);
    }
    if (!b.name?.ko || !b.name?.en) errors.push(`${b.id}: name.ko/en 비어 있음`);
    if (!b.region?.sigungu?.ko || !b.region?.sido?.ko) errors.push(`${b.id}: 시·도/시·군 비어 있음`);
    for (const m of METRICS) if (!(m in (b.stations ?? {}))) errors.push(`${b.id}: stations.${m} 칸 없음`);
    if (!b._draft?.coordsSource) errors.push(`${b.id}: 좌표 출처 없음`);
    if (!b._draft?.coast) errors.push(`${b.id}: 해안 구분 없음`);
  }
  report("필수 칸 누락", errors);
  console.log(`  (참고) slug 미정(전국 slug 결정 대기) ${deferred.length}곳: ${deferred.join(", ")}`);
}

// 2) slug 형식 (확정 후보 + 미정 해변의 후보 모두)
{
  const errors = [];
  for (const b of beaches) {
    const list = b.slug === null ? (b._draft?.slugCandidates ?? []) : [b.slug];
    if (b.slug === null && list.length === 0) errors.push(`${b.id}: slug 후보 없음`);
    for (const s of list) if (!SLUG_RE.test(s)) errors.push(`${b.id}: 형식 위반 '${s}'`);
  }
  report("slug 형식", errors);
}

// 3) slug·id 중복 (미정 해변 후보가 확정 slug와 겹치는지도 확인)
{
  const errors = [];
  const ids = new Map();
  const slugs = new Map();
  for (const b of beaches) {
    if (ids.has(b.id)) errors.push(`id 중복: ${b.id}`);
    ids.set(b.id, true);
    if (b.slug !== null) {
      if (slugs.has(b.slug)) errors.push(`slug 중복: ${b.slug} (${slugs.get(b.slug)}, ${b.id})`);
      slugs.set(b.slug, b.id);
    }
  }
  for (const b of beaches.filter((x) => x.slug === null))
    for (const s of b._draft.slugCandidates)
      if (slugs.has(s)) errors.push(`${b.id}: 후보 '${s}'가 확정 후보 slug(${slugs.get(s)})와 겹침`);
  report("slug·id 중복", errors);
}

// 4) 20km 초과인데 관측소가 들어간 경우 + 대표 제외 측정기 사용
{
  const errors = [];
  for (const b of beaches)
    for (const m of METRICS) {
      const s = b.stations[m];
      if (s && !(s.distanceKm <= 20)) errors.push(`${b.id} ${m}: ${s.id} ${s.distanceKm}km`);
      if (s && ["22460", "22501"].includes(s.id)) errors.push(`${b.id} ${m}: 대표 제외 측정기 ${s.id}`);
    }
  report("20km 초과 관측소·대표 제외 측정기", errors);
}

// 5) beach-rules.mjs checkList (파일 이름 = id.json으로 가정, slug 확정 후보만)
{
  const items = beaches.filter((b) => b.slug !== null).map((b) => ({ file: `${b.id}.json`, beach: b }));
  report(`beach-rules.mjs checkList (slug 있는 ${items.length}곳)`, checkList(items));
}

// 6) 계약 $defs/Beach 스키마 (ajv 8, packages/contracts 설치본)
{
  const req = createRequire(join(ROOT, "packages/contracts/package.json"));
  let Ajv2020;
  let addFormats;
  try {
    Ajv2020 = req("ajv/dist/2020.js").default ?? req("ajv/dist/2020.js");
    addFormats = req("ajv-formats").default ?? req("ajv-formats");
  } catch (e) {
    report("계약 검사 의존성", [`ajv 로드 실패: ${e.message}`]);
  }
  if (Ajv2020) {
    const schema = JSON.parse(readFileSync(join(ROOT, "packages/contracts/schemas/contract.schema.json"), "utf8"));
    const ajv = new Ajv2020({ allErrors: true, allowUnionTypes: true, strictTypes: false });
    addFormats(ajv);
    ajv.addSchema(schema);
    const validate = ajv.getSchema(`${schema.$id}#/$defs/Beach`);
    const run = (label, list) => {
      const errors = [];
      for (const b of list)
        if (!validate(b)) for (const e of validate.errors) {
          const hold = slugHolds.get(b.id);
          if (label === "계약 Beach 스키마 — 레코드 그대로(_draft 제거)" && b.slug === null && hold?.reason &&
              e.instancePath === "/slug" && e.keyword === "type" && e.params.type === "string") {
            expectedCount++;
            console.log(`[예상 보류] ${b.id}: /slug ${e.message} — ${hold.reason}`);
          } else errors.push(`${b.id}: ${e.instancePath || "(전체)"} ${e.message}`);
        }
      report(label, errors);
    };
    // 6-1) 그대로 (slug null 해변은 실패가 예상됨)
    run("계약 Beach 스키마 — 레코드 그대로(_draft 제거)", beaches.map(strip));
    // 6-2) slug 미정 해변에 첫 후보를 넣고 나머지 칸 검증
    run(
      "계약 Beach 스키마 — slug 미정 해변에 첫 후보 대입",
      beaches.map((b) => ({ ...strip(b), slug: b.slug ?? b._draft.slugCandidates[0] })),
    );
    // 6-3) 공개 beaches.json(BeachesFile) 모양
    const validateFile = ajv.getSchema(`${schema.$id}#/$defs/BeachesFile`);
    const file = { beaches: beaches.map((b) => ({ ...strip(b), slug: b.slug ?? b._draft.slugCandidates[0] })) };
    report("계약 BeachesFile 스키마 — { beaches: [...] } 묶음", validateFile(file) ? [] : validateFile.errors.map((e) => `${e.instancePath} ${e.message}`));
  }
}

// 독립 검증 입력과 배정 결과의 일치 검사
{
  const errors = [];
  const stationRows = JSON.parse(readFileSync(join(COVERAGE_DIR, "station-zone-evidence.json"), "utf8")).stations;
  const stationById = new Map(stationRows.map((s) => [s.stn_id, s]));
  const evidence = JSON.parse(readFileSync(join(COVERAGE_DIR, "beach-zone-evidence.json"), "utf8")).beaches;
  for (const b of beaches) {
    const e = evidence.find((r) => r.key === `${b.region.sigungu.ko}|${b._draft.sourceName}`);
    if (!e || ["land", "sea"].some((kind) =>
      (b.warningZones?.[kind] ?? b._draft?.zoneCandidates?.[kind]) !== e[`${kind}_zone`]) || !b._draft.zoneEvidence)
      errors.push(`${b.id}: 해변 구역 검토 입력 불일치`);
    for (const metric of METRICS) {
      const s = b.stations[metric];
      const proof = s && stationById.get(s.id);
      if (s && !(proof?.status === "VERIFIED" && proof.zone === b.warningZones?.sea && proof.boundary_source_url && proof.boundary_rule_item && proof.checked_at_kst && proof.basis && stationSourceOk(proof.boundary_source)))
        errors.push(`${b.id} ${metric}: 독립 검증되지 않은 관측소 배정`);
    }
    // 20km 안 미검증 관측소가 배정 관측소보다 가깝고(null이면 하나라도) 그 지표 실응답 값이 있으면 확정 불가
    for (const metric of METRICS) {
      const s = b.stations[metric];
      const blockers = stationRows.filter((r) => {
        const live = r.metrics?.[metric]?.live_state;
        if (r.status === "VERIFIED" || (live && live !== "VALUE_PRESENT")) return false;
        if (r.status === "VERIFIED_NOT_IN_ZONE" && r.not_in_zones?.includes(b.warningZones?.sea) && r.basis) return false;
        const km = haversine(b.coords.lat, b.coords.lng, Number(r.lat), Number(r.lon));
        return km <= 20 && (!s || km < s.distanceKm);
      });
      if (b._draft.stationMappingStatus === "VERIFIED" && blockers.length)
        errors.push(`${b.id} ${metric}: 20km 안 미검증 관측소 ${blockers.map((r) => r.stn_id).join("·")}가 있는데 확정 처리`);
    }
  }
  const excludedIds = new Set((draft._meta.releaseExcluded ?? []).map((x) => x.id));
  for (const x of draft._meta.releaseExcluded ?? []) {
    const e = evidence.find((r) => r.key === x.key);
    if (!e?.release_exclusion?.items?.length || !x.items?.every((i) => i.type && i.reason)) errors.push(`${x.id}: 자동 제외 사유 근거 없음`);
    if (beaches.some((b) => b.id === x.id)) errors.push(`${x.id}: 자동 제외 해변이 레코드에 남음`);
  }
  for (const b of beaches)
    if (evidence.find((r) => r.key === `${b.region.sigungu.ko}|${b._draft.sourceName}`)?.release_exclusion && !excludedIds.has(b.id))
      errors.push(`${b.id}: 자동 제외 대상인데 레코드 생성`);
  report("독립 검증 입력·구역 미검증 표시·자동 제외", errors);
}

// 미검증 구역·지표별 관측소의 본문 유입 차단 및 승격 가능 수 집계
{
  const errors = [];
  const stationRows = JSON.parse(readFileSync(join(COVERAGE_DIR, "station-zone-evidence.json"), "utf8")).stations;
  const stationById = new Map(stationRows.map((s) => [s.stn_id, s]));
  const evidence = JSON.parse(readFileSync(join(COVERAGE_DIR, "beach-zone-evidence.json"), "utf8")).beaches;
  let promotable = 0;
  const blockers = { S1: 0, L1: 0, 관측소: 0, 실응답: 0 };
  for (const b of beaches) {
    const e = evidence.find((r) => r.key === `${b.region.sigungu.ko}|${b._draft?.sourceName}`);
    const firstError = errors.length;
    const zoneVerified = (kind) => zoneProofVerified(e, kind, b.region.sigungu.ko) &&
      b._draft?.zoneEvidence?.[`${kind}_status`] === "검증";
    if (!zoneVerified("sea")) blockers.S1++;
    if (!zoneVerified("land")) blockers.L1++;
    const absenceVerified = (metric) => e?.station_absence?.[metric]?.status === "VERIFIED" &&
      e.station_absence[metric].basis && e.station_absence[metric].checked_at_kst;
    if (b._draft?.stationMappingStatus !== "VERIFIED" || !METRICS.every((metric) => {
      const s = b.stations?.[metric];
      return s ? stationById.get(s.id)?.status === "VERIFIED" : absenceVerified(metric);
    })) blockers.관측소++;
    if (!METRICS.every((metric) => {
      const s = b.stations?.[metric];
      return s ? stationById.get(s.id)?.metrics?.[metric]?.status === "VERIFIED" &&
        b._draft?.stationVerification?.[metric] === "VERIFIED" : absenceVerified(metric);
    })) blockers.실응답++;
    for (const kind of ["land", "sea"]) {
      const value = b.warningZones?.[kind];
      if (value !== undefined && value !== null && !(zoneVerified(kind) && value === e[`${kind}_zone`]))
        errors.push(`${b.id}: warningZones.${kind} 미검증인데 본문에 값 존재`);
      if (value !== undefined && b._draft?.zoneCandidates?.[kind] !== undefined)
        errors.push(`${b.id}: ${kind} 구역이 본문·후보에 중복 존재`);
    }
    for (const kind of Object.keys(b.warningZones ?? {}))
      if (!["land", "sea"].includes(kind)) errors.push(`${b.id}: 모르는 구역 ${kind} 본문 유입`);
    for (const metric of METRICS) {
      const s = b.stations?.[metric];
      if (s === undefined || s === null) continue;
      const proof = stationById.get(s.id);
      if (!(proof?.status === "VERIFIED" && proof.metrics?.[metric]?.status === "VERIFIED" &&
          b._draft?.stationVerification?.[metric] === "VERIFIED" && zoneVerified("sea") && proof.zone === b.warningZones?.sea))
        errors.push(`${b.id}: stations.${metric} 관측소·지표·구역이 VERIFIED가 아닌데 본문에 값 존재`);
    }
    if (errors.length === firstError && ["land", "sea"].every((kind) => zoneVerified(kind) && b.warningZones?.[kind] === e[`${kind}_zone`]) &&
        b._draft?.stationMappingStatus === "VERIFIED" && METRICS.every((metric) =>
          b.stations[metric] ? b._draft?.stationVerification?.[metric] === "VERIFIED" :
            e.station_absence?.[metric]?.status === "VERIFIED" && e.station_absence[metric].basis && e.station_absence[metric].checked_at_kst) &&
        typeof b.slug === "string" && SLUG_RE.test(b.slug)) promotable++;
  }
  report("승격 가능 검사 — 미검증 본문 값 차단", errors);
  const total = beaches.length + (draft._meta.releaseExcluded?.length ?? 0);
  console.log(`승격 가능 ${promotable}곳/${total}곳 (레코드 ${beaches.length}곳, 출시 자동 제외 ${total - beaches.length}곳)`);
  console.log(`승격 차단(중복 집계): ${JSON.stringify(blockers)}`);
}

const failed = results.filter((r) => r.errors.length);
console.log(`\n요약: 검사 ${results.length}개 중 실패 ${failed.length}개 (${failed.map((r) => r.name).join(" · ") || "없음"})`);
console.log(`예상 보류: slug ${expectedCount}건, 좌표 ${holds.coordinates.length}곳`);
process.exitCode = failed.length ? 1 : 0;
