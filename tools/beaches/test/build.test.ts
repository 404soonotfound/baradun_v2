import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// 생성기 회귀는 외부 원자료 없이 고정된 검증 결과를 주입함.
// 실제 원자료 해시·GIS 판정은 저장본 재생성 검증에서 별도로 확인함.
vi.mock("../zone-proof.mjs", () => ({
  stationSourceOk: () => true,
  zoneProofVerified: (e, kind) => e?.[`${kind}_status`] === "VERIFIED",
}));
import { buildBeaches, writeBuild } from "../build.mjs";
import { checkDraft } from "../check.mjs";
import { idKey, validateIdentity, preserveManual, reserveSlug } from "../identity.mjs";
import { validateCoverage } from "../../../packages/contracts/scripts/coverage-rules.mjs";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((p) => rmSync(p, { recursive: true, force: true })));
const source = (name = "강문", sigungu = "강릉시", sido = "강원") => ({ sido_nm: sido, gugun_nm: sigungu, sta_nm: name, lat: "37.796618", lon: "128.917591" });
const metrics = ["waveHeight", "waterTemp", "wind", "wavePeriod", "waveDirection"];
function fixture(sources = [source()]) {
  const root = mkdtempSync(join(tmpdir(), "brd80-"));
  roots.push(root);
  const put = (p, v) => { mkdirSync(dirname(join(root, p)), { recursive: true }); writeFileSync(join(root, p), typeof v === "string" ? v : JSON.stringify(v)); };
  put("input/out/beaches.csv", "sido_nm,gugun_nm,sta_nm,lat,lon\n" + sources.map((s) => Object.values(s).join(",")).join("\n") + "\n");
  put("input/out/stations.csv", "stn_id,tp,lat,lon\n");
  put("input/out/freshness/sea_obs_72h.csv", "req_tm,stn,wh,tw\n2026102000,99999,1,20\n");
  put("input/out/freshness/kma_buoy2_7d.csv", "tm,stn,wp,wo\n");
  put("input/responses/metric-matrix.json", { stations: [], sources: { sea_obs: { status: "RECEIVED", http_status: 200 }, kma_buoy: { status: "RECEIVED", http_status: 200 } } });
  put("input/station-zone-evidence.json", { stations: [] });
  put("input/beach-zone-evidence.json", { beaches: sources.map((s) => ({
    key: `${s.gugun_nm}|${s.sta_nm}`, address_status: "UNVERIFIED", land_status: "VERIFIED", sea_status: "VERIFIED",
    land_zone: "L1022510", sea_zone: "S1151200", land_basis: "고정 픽스처", sea_basis: "고정 픽스처",
    land_rule_url: "https://example.org/land", sea_rule_url: "https://example.org/sea",
    land_checked_at_kst: "2026-10-22T10:00:00+09:00", sea_checked_at_kst: "2026-10-22T10:00:00+09:00",
    station_absence: Object.fromEntries(metrics.map((m) => [m, { status: "VERIFIED", basis: "20km 안 후보 없음", checked_at_kst: "2026-10-22T10:00:00+09:00" }])),
    official_address_2026: { basis: "고정 픽스처", source: { name: "고정 공식 현황", url: "https://example.org/season" }, season2026: { status: "미개장", openDate: null, closeDate: null } },
  })) });
  put("ids-input.json", { ids: {} });
  mkdirSync(join(root, "existing/beaches"), { recursive: true });
  const options = { coverageDir: join(root, "input"), existingDataDir: join(root, "existing"), idsInput: join(root, "ids-input.json"), outputDir: join(root, "output"), dataOutputDir: join(root, "output/data"), idsOutput: join(root, "output/ids.json"), regions: ["강원", "부산"], publish: true, verifySources() {} };
  const build = () => buildBeaches(options);
  const seed = () => {
    const p = build();
    const b = JSON.parse(p.files.get(join(root, "output/data/beaches/b0001.json")));
    put("existing/beaches/b0001.json", b);
    put("existing/beach-coverage.csv", p.files.get(join(root, "output/data/beach-coverage.csv")));
    put("ids-input.json", p.files.get(join(root, "output/ids.json")));
    return b;
  };
  return { root, put, options, build, seed };
}
const fingerprint = (root) => {
  const hash = createHash("sha256");
  const walk = (dir) => { for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) { const p = join(dir, e.name); if (e.isDirectory()) walk(p); else hash.update(p).update(readFileSync(p)); } };
  walk(root); return hash.digest("hex");
};

describe("대표 측정기 공통 규칙을 적용하는 초안 검사", () => {
  it.each([["99999", 20, false], ["99999", 20.1, true], ["99999", NaN, true], ["22460", 1, true], ["22501", 1, true]])("%s 거리 %s의 상한·대표 제외 판정", (id, distanceKm, rejected) => {
    const f = fixture(); const { draft } = f.build();
    draft.beaches[0].stations.waveHeight = { id, distanceKm };
    const results = checkDraft({ draft, coverageDir: f.options.coverageDir, regions: f.options.regions, quiet: true });
    const result = results.find((r) => r.name.includes("초과 관측소·대표 제외"));
    expect(result.errors.length > 0).toBe(rejected);
  });
  it.each([[0.179, true], [0.181, false]])("위도 차이 %s도인 미검증 후보의 20km 경계를 대원거리로 검사", (delta, blocked) => {
    const f = fixture(); const { draft } = f.build();
    const b = draft.beaches[0];
    f.put("input/station-zone-evidence.json", { stations: [{ stn_id: "99999", lat: b.coords.lat + delta, lon: b.coords.lng, status: "UNVERIFIED", metrics: { waveHeight: { live_state: "VALUE_PRESENT" } } }] });
    const results = checkDraft({ draft, coverageDir: f.options.coverageDir, regions: f.options.regions, quiet: true });
    const result = results.find((r) => r.name === "독립 검증 입력·구역 미검증 표시·자동 제외");
    expect(result.errors.some((e) => e.includes("20km 안 미검증 관측소"))).toBe(blocked);
  });
});

describe("쓰기 없는 생성·최종 객체 검증", () => {
  it("import·검증·두 번 생성은 저장소와 임시 입력을 바꾸지 않고 쓰기는 명시적으로 실행함", () => {
    const f = fixture();
    const repoIds = readFileSync(new URL("../ids.json", import.meta.url));
    const before = fingerprint(f.root);
    const a = f.build(); const b = f.build();
    expect([...a.files]).toEqual([...b.files]);
    expect(fingerprint(f.root)).toBe(before);
    expect(readFileSync(new URL("../ids.json", import.meta.url))).toEqual(repoIds);
    expect(existsSync(join(f.root, "output"))).toBe(false);
    writeBuild(a);
    expect(existsSync(join(f.root, "output/ids.json"))).toBe(true);
    expect(readFileSync(f.options.idsInput, "utf8")).toContain('"ids":{}');
  });
  it("잘못된 초안은 ID 대장과 출력 폴더를 쓰지 않음", () => {
    const f = fixture();
    f.put("input/responses/metric-matrix.json", { stations: [] });
    const before = fingerprint(f.root);
    expect(f.build).toThrow(/실응답/);
    expect(fingerprint(f.root)).toBe(before);
  });
  it("출력 폴더만 지정해도 ID 대장과 공개 데이터 출력은 그 폴더 안에 생김", () => {
    const f = fixture();
    const { idsOutput, dataOutputDir, ...options } = f.options;
    const plan = buildBeaches(options);
    expect([...plan.files.keys()].every((p) => p.startsWith(join(f.root, "output/")))).toBe(true);
    expect(plan.files.has(join(f.root, "output/ids.json"))).toBe(true);
    expect(plan.files.has(join(f.root, "output/data/beaches/b0001.json"))).toBe(true);
  });
  it("수정한 영문명·활동·사진·CCTV와 수동 숨김을 보존함", () => {
    const f = fixture(); const prev = f.seed();
    Object.assign(prev, { name: { ...prev.name, en: "Edited English Beach" }, activities: ["swimming", "surfing"], photo: { url: "https://example.org/p.jpg", source: "공공누리 사진", license: "kogl-type1" }, cctv: { url: "https://example.org/cctv", source: "고정 CCTV" }, hidden: true });
    f.put("existing/beaches/b0001.json", prev);
    const plan = f.build();
    expect(JSON.parse(plan.files.get(join(f.root, "output/data/beaches/b0001.json")))).toEqual(prev);
    expect(plan.files.get(join(f.root, "output/data/beach-coverage.csv"))).toContain("gangmun,true,");
  });
  it("신규 해변에는 수영·null 사진·null CCTV·숨김 false 기본값을 사용함", () => {
    const f = fixture(); const b = f.build().draft.beaches[0];
    expect(b).toMatchObject({ name: { en: "Gangmun Beach" }, activities: ["swimming"], photo: null, cctv: null, hidden: false });
  });
  it.each([ ["activities", null], ["activities", ["snorkeling"]], ["photo", { url: "http://example.org/p", source: "x", license: "kogl-type1" }], ["cctv", { url: "http://example.org/c", source: "x" }], ["hidden", null], ["name", { ko: "강문해수욕장", en: "" }] ])("잘못된 보존값 %s는 최종 계약에서 거부하고 출력하지 않음", (key, value) => {
    const f = fixture(); const prev = f.seed(); prev[key] = value;
    f.put("existing/beaches/b0001.json", prev);
    const before = fingerprint(f.root);
    expect(f.build).toThrow(/최종 Beach 계약/);
    expect(fingerprint(f.root)).toBe(before);
  });
});

describe("ID와 slug 사전검증", () => {
  it("JSON 없는 자동 제외 b0092 일광·b0093 임랑 ID 교환도 쓰기 전에 거부함", () => {
    const sources = [source("일광", "기장군", "부산"), source("임랑", "기장군", "부산")];
    const f = fixture(sources);
    f.put("ids-input.json", { ids: { [idKey(sources[0])]: "b0092", [idKey(sources[1])]: "b0093" } });
    const evidencePath = join(f.root, "input/beach-zone-evidence.json");
    const evidence = JSON.parse(readFileSync(evidencePath, "utf8"));
    for (const e of evidence.beaches)
      e.release_exclusion = { items: [{ type: "NOT_DESIGNATED_2026", reason: "자동 제외 고정 픽스처" }] };
    f.put("input/beach-zone-evidence.json", evidence);
    const initial = f.build();
    expect(initial.draft.beaches).toEqual([]);
    expect([...initial.files.keys()].some((p) => /\/beaches\/b009[23]\.json$/.test(p))).toBe(false);
    f.put("existing/beach-coverage.csv", initial.files.get(join(f.root, "output/data/beach-coverage.csv")));
    expect(f.build().matrix.map((r) => r.id)).toEqual(["b0092", "b0093"]);
    f.put("ids-input.json", { ids: { [idKey(sources[0])]: "b0093", [idKey(sources[1])]: "b0092" } });
    const before = fingerprint(f.root);
    expect(f.build).toThrow(/ID 대장·원자료 정체성 불일치/);
    expect(fingerprint(f.root)).toBe(before);
    expect(existsSync(join(f.root, "output"))).toBe(false);
  });
  it("동명 해변끼리 대장 ID를 맞바꾸면 정체성 불일치로 중단하고 파일을 쓰지 않음", () => {
    const sources = [source("송정"), source("송정", "해운대구", "부산")];
    const f = fixture(sources);
    const initial = f.build();
    for (const id of ["b0001", "b0002"])
      f.put(`existing/beaches/${id}.json`, initial.files.get(join(f.root, `output/data/beaches/${id}.json`)));
    f.put("existing/beach-coverage.csv", initial.files.get(join(f.root, "output/data/beach-coverage.csv")));
    f.put("ids-input.json", { ids: { [idKey(sources[0])]: "b0001", [idKey(sources[1])]: "b0002" } });
    expect(f.build().draft.beaches.map((b) => b.slug)).toEqual(["gangneung-songjeong", "haeundae-songjeong"]);
    f.put("ids-input.json", { ids: { [idKey(sources[0])]: "b0002", [idKey(sources[1])]: "b0001" } });
    const before = fingerprint(f.root);
    expect(f.build).toThrow(/ID 대장·원자료 정체성 불일치/);
    expect(fingerprint(f.root)).toBe(before);
    expect(existsSync(join(f.root, "output"))).toBe(false);
  });
  it("새 동명 해변은 시군 접두사, 기존 공개 slug는 그대로 유지함", () => {
    const f = fixture([source("송정"), source("송정", "해운대구", "부산")]);
    const old = f.seed(); old.slug = "songjeong"; f.put("existing/beaches/b0001.json", old);
    const bs = f.build().draft.beaches;
    expect(bs.map((b) => b.slug)).toEqual(["songjeong", "haeundae-songjeong"]);
  });
  it("숨김 slug 충돌과 신규끼리의 로마자 충돌은 쓰기 전에 실패함", () => {
    const f = fixture([source("강문"), source("경포")]);
    const old = f.seed(); old.slug = "gyeongpo"; old.hidden = true; f.put("existing/beaches/b0001.json", old);
    expect(f.build).toThrow(/slug 재사용 금지/);
    const owners = new Map();
    reserveSlug(owners, "same-romanization", "b0001");
    expect(() => reserveSlug(owners, "same-romanization", "b0002")).toThrow(/새 규칙 없이 생성 중단/);
  });
  it("대장 중복·없는 ID·파일명 불일치·원자료 이름 변경을 거부함", () => {
    const src = source(); const ids = { ids: { [idKey(src)]: "b0001" } };
    expect(() => validateIdentity({ ids: { a: "b0001", b: "b0001" } }, [], [src])).toThrow(/ID 대장 중복/);
    expect(() => validateIdentity(ids, [{ file: "b0002.json", beach: { id: "b0001", slug: "a" } }], [src])).toThrow(/파일 이름/);
    expect(() => validateIdentity(ids, [{ file: "b0002.json", beach: { id: "b0002", slug: "a" } }], [src])).toThrow(/대장·기존 파일/);
    expect(() => validateIdentity(ids, [], [source("새 이름")])).toThrow(/사라졌거나 이름이 바뀜/);
  });
  it("같은 ID의 한국어 이름 변경은 명확히 중단함", () => {
    expect(() => preserveManual({ id: "b0001", name: { ko: "새 이름" } }, { name: { ko: "옛 이름" } })).toThrow(/같은 ID 이름 변경/);
  });
  it("원자료에서 기존 해변이 사라지면 숨기지 않고 전체 중단함", () => {
    const f = fixture(); f.seed();
    f.put("input/out/beaches.csv", "sido_nm,gugun_nm,sta_nm,lat,lon\n");
    const before = fingerprint(f.root);
    expect(f.build).toThrow(/자동 숨김·이름 변경 대응 없이 생성 중단/);
    expect(fingerprint(f.root)).toBe(before);
  });
});

it("매트릭스 hidden과 JSON이 다르거나 칸이 없으면 실패함", () => {
  const f = fixture(); const plan = f.build();
  const beach = JSON.parse(plan.files.get(join(f.root, "output/data/beaches/b0001.json")));
  const meta = JSON.parse(plan.files.get(join(f.root, "output/data/beach-meta.json")));
  expect(validateCoverage({ beaches: [beach], matrix: [{ ...plan.matrix[0], hidden: "true" }], meta }).join()).toContain("hidden 불일치");
  expect(validateCoverage({ beaches: [beach], matrix: [plan.matrix[0]], meta }).join()).toContain("hidden 불일치");
});

it("check:coverage CLI가 최종 출력에서 성공하고 hidden 불일치에서는 실패함", () => {
  const f = fixture();
  writeBuild(f.build());
  const script = fileURLToPath(new URL("../../../packages/contracts/scripts/check-coverage.mjs", import.meta.url));
  const run = () => spawnSync(process.execPath, [script, join(f.root, "output/data")], { encoding: "utf8" });
  const ok = run();
  expect(ok.status, ok.stderr).toBe(0);
  expect(ok.stdout).toContain("매트릭스 검사 통과");
  const csv = readFileSync(join(f.root, "output/data/beach-coverage.csv"), "utf8");
  f.put("output/data/beach-coverage.csv", csv.replace("gangmun,false,", "gangmun,true,"));
  const bad = run();
  expect(bad.status).toBe(1);
  expect(bad.stderr).toContain("hidden 불일치");
});
