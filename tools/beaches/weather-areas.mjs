// BRD-181 해변 → 날씨 예보 구역 대응표(data/weather-areas.json) 만들기 (결정 기록 18장 D18-1·D18-8·D18-9)
// - 단기예보·초단기실황: 해변 좌표 → 기상청 5km 격자(nx, ny). 기상청 단기예보 활용가이드의 LCC 변환식
// - 중기예보 기온 지점(getMidTa): 해변 시·군 이름과 같은 지점. 광역시의 구·군은 그 광역시 지점(2026-11-05 사용자 결정)
//   광역시의 군(예: 인천 옹진군)은 해상 특보구역(앞바다)이 그 광역시 구 해변과 같을 때만 광역시 지점을 씀
//   → 서해5도처럼 먼 섬(인천·경기북부앞바다)이 인천 지점에 조용히 붙지 않고 멈춤
//   같은 이름이 없으면 멈춤(같은 구역 최근접 규칙은 지점 좌표가 공식 코드표에 없어 만들지 않음)
// - 중기예보 육상 구역(getMidLandFcst): 기온 지점 코드가 속한 구역. 해변 시도와 맞는지 한 번 더 대조
// 코드표 원본: tools/beaches/mid-zones.json(활용가이드 첨부 xlsx에서 옮김, 출처·해시는 그 파일 _meta)
// 공개 해변(hidden false)만 넣음
// 실행: node tools/beaches/weather-areas.mjs [--check] [--verify]
//   --check: 파일을 쓰지 않고 지금 data/weather-areas.json과 같은지만 확인(다르면 종료 코드 1)
//   --verify: DATA_GO_KR_SERVICE_KEY로 격자·구역·지점마다 한 번씩 실호출해 응답이 오는지 확인하고 결과를 _meta.verified에 남김
//   키는 환경 변수로만 읽고 출력·저장하지 않음. 포털의 디코딩 키·인코딩 키 둘 다 받음(%가 있으면 한 번 풀어 씀)
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA = join(HERE, "../../data");
const OUT = join(DATA, "weather-areas.json");
const ZONES = JSON.parse(readFileSync(join(HERE, "mid-zones.json"), "utf8"));

// 기상청 단기예보 격자 변환 상수(활용가이드 'LCC DFS 좌표변환'). 지구 반경 km, 격자 간격 km, 투영 위도·기준점
const LCC = {
  re: 6371.00877,
  grid: 5.0,
  slat1: 30.0,
  slat2: 60.0,
  olon: 126.0,
  olat: 38.0,
  xo: 43,
  yo: 136,
};

// 위경도 → 격자. 활용가이드 C 예제와 같은 식(반올림은 floor(x + 0.5))
export function toGrid(lat, lng) {
  const rad = Math.PI / 180;
  const re = LCC.re / LCC.grid;
  const slat1 = LCC.slat1 * rad;
  const slat2 = LCC.slat2 * rad;
  const olon = LCC.olon * rad;
  const olat = LCC.olat * rad;
  let sn =
    Math.tan(Math.PI * 0.25 + slat2 * 0.5) /
    Math.tan(Math.PI * 0.25 + slat1 * 0.5);
  sn = Math.log(Math.cos(slat1) / Math.cos(slat2)) / Math.log(sn);
  let sf = Math.tan(Math.PI * 0.25 + slat1 * 0.5);
  sf = (Math.pow(sf, sn) * Math.cos(slat1)) / sn;
  let ro = Math.tan(Math.PI * 0.25 + olat * 0.5);
  ro = (re * sf) / Math.pow(ro, sn);
  let ra = Math.tan(Math.PI * 0.25 + lat * rad * 0.5);
  ra = (re * sf) / Math.pow(ra, sn);
  let theta = lng * rad - olon;
  if (theta > Math.PI) theta -= 2.0 * Math.PI;
  if (theta < -Math.PI) theta += 2.0 * Math.PI;
  theta *= sn;
  return {
    nx: Math.floor(ra * Math.sin(theta) + LCC.xo + 0.5),
    ny: Math.floor(ro - ra * Math.cos(theta) + LCC.yo + 0.5),
  };
}

// 기온 지점 코드 → 육상 구역 코드. 코드표에 구역-지점 대응 칸이 없어 코드 앞자리로 묶음
// 21F1…(전북 서해안)·21F2…(전남 서해안)은 11F 구역에 속함. 11B는 시도 하나(서울·인천·경기) 구역
const LAND_BY_PREFIX = [
  [/^11B/, "11B00000"],
  [/^11C1/, "11C10000"],
  [/^11C2/, "11C20000"],
  [/^11D1/, "11D10000"],
  [/^11D2/, "11D20000"],
  [/^(11|21)F1/, "11F10000"],
  [/^(11|21)F2/, "11F20000"],
  [/^11G/, "11G00000"],
  [/^11H1/, "11H10000"],
  [/^11H2/, "11H20000"],
];

// 해변 시도(data/beaches region.sido.ko)가 속할 수 있는 육상 구역. 강원은 영서·영동 둘 중 지점 코드로 정함
const LAND_BY_SIDO = {
  서울: ["11B00000"],
  인천: ["11B00000"],
  경기: ["11B00000"],
  충북: ["11C10000"],
  충남: ["11C20000"],
  대전: ["11C20000"],
  세종: ["11C20000"],
  강원: ["11D10000", "11D20000"],
  전북: ["11F10000"],
  전남: ["11F20000"],
  광주: ["11F20000"],
  제주: ["11G00000"],
  경북: ["11H10000"],
  대구: ["11H10000"],
  경남: ["11H20000"],
  부산: ["11H20000"],
  울산: ["11H20000"],
};
const METRO = new Set(["서울", "부산", "대구", "인천", "광주", "대전", "울산"]);

export function landOf(taRegId) {
  const hit = LAND_BY_PREFIX.find(([re]) => re.test(taRegId));
  if (!hit) throw new RangeError(`육상 구역을 정할 수 없는 지점: ${taRegId}`);
  return hit[1];
}

// 해변 하나 → 기온 지점·육상 구역. 이름이 맞는 지점이 정확히 하나가 아니면 멈춤(추측하지 않음)
// citySea: 광역시 → 그 광역시 구 해변들의 앞바다 코드(buildAreas가 공개 해변에서 모음)
export function midAreaOf(beach, zones = ZONES, citySea = new Map()) {
  const sido = beach.region.sido.ko;
  const sigungu = beach.region.sigungu.ko;
  const allowed = LAND_BY_SIDO[sido];
  if (!allowed) throw new RangeError(`${beach.id}: 모르는 시도 ${sido}`);
  const metro = METRO.has(sido);
  if (metro && !/구$/.test(sigungu)) {
    const sea = beach.warningZones?.sea;
    if (!sea || !citySea.get(sido)?.has(sea)) {
      throw new RangeError(
        `${beach.id}: ${sido} ${sigungu} 앞바다 ${sea ?? "없음"}가 ${sido} 구 해변과 달라 광역시 지점을 쓰지 않음`,
      );
    }
  }
  const wanted = metro ? sido : sigungu.replace(/(시|군|구)$/, "");
  const hits = zones.ta.filter(
    (t) => t.name === wanted && allowed.includes(landOf(t.regId)),
  );
  if (hits.length !== 1) {
    throw new RangeError(
      `${beach.id}: ${sido} ${sigungu} → 기온 지점 '${wanted}' ${hits.length}곳`,
    );
  }
  const ta = hits[0];
  const landId = landOf(ta.regId);
  const land = zones.land.find((l) => l.regId === landId);
  if (!land)
    throw new RangeError(`${beach.id}: 코드표에 없는 육상 구역 ${landId}`);
  return {
    midLand: { regId: land.regId, name: land.name },
    midTa: {
      regId: ta.regId,
      name: ta.name,
      rule: metro ? "metro" : "sigungu",
    },
  };
}

export function readPublicBeaches(dir = join(DATA, "beaches")) {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")))
    .filter((b) => b.hidden === false)
    .sort((a, b) => a.id.localeCompare(b.id));
}

export function buildAreas(beaches, zones = ZONES) {
  const citySea = new Map();
  for (const b of beaches) {
    if (!METRO.has(b.region.sido.ko) || !/구$/.test(b.region.sigungu.ko))
      continue;
    const set = citySea.get(b.region.sido.ko) ?? new Set();
    if (b.warningZones?.sea) set.add(b.warningZones.sea);
    citySea.set(b.region.sido.ko, set);
  }
  const out = {};
  for (const beach of beaches) {
    out[beach.id] = {
      grid: toGrid(beach.coords.lat, beach.coords.lng),
      ...midAreaOf(beach, zones, citySea),
    };
  }
  return out;
}

// 대응표가 쓰는 격자·육상 구역·기온 지점(중복 없이, 정렬)
export function codeSets(areas) {
  const values = Object.values(areas);
  const uniq = (list) => [...new Set(list)].sort();
  return {
    grids: uniq(values.map((a) => `${a.grid.nx},${a.grid.ny}`)),
    midLand: uniq(values.map((a) => a.midLand.regId)),
    midTa: uniq(values.map((a) => a.midTa.regId)),
  };
}

// 실호출로 확인한 코드 묶음의 지문. 대응이 바뀌면 달라져 이전 확인 기록을 그대로 믿지 않게 함
export function codesDigest(sets) {
  return createHash("sha256").update(JSON.stringify(sets)).digest("hex");
}

const META = {
  note: "BRD-181 해변 → 기상청 날씨 예보 구역. 생성: node tools/beaches/weather-areas.mjs (규칙은 그 파일 머리 주석)",
  grid: "기상청 단기예보·초단기실황 5km 격자(nx, ny). 단기예보 활용가이드 LCC 변환식",
  midTa:
    "중기예보 기온 지점(getMidTa regId). 해변 시·군 이름과 같은 지점, 광역시의 구·군은 광역시 지점(rule: sigungu·metro)",
  midLand:
    "중기예보 육상 구역(getMidLandFcst regId). 기온 지점이 속한 구역, 해변 시도와 대조",
  zoneTable: "tools/beaches/mid-zones.json",
};

const KST_MS = 9 * 60 * 60 * 1000;
const pad = (n) => String(n).padStart(2, "0");
const kstParts = (ms) => {
  const d = new Date(ms + KST_MS);
  return {
    day: `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`,
    hour: d.getUTCHours(),
    minute: d.getUTCMinutes(),
  };
};

// 지금 받을 수 있는 가장 늦은 발표 시각(KST). 단기 02·05·…·23시(활용가이드: 발표 10분 뒤 제공)
// 중기 06·18시는 제공 시각 근거가 없어 1시간 여유를 둠(덜 기다려 '행 없음'을 대응 오류로 읽지 않게)
function latestBase(nowMs, hours, delayMinutes) {
  for (let back = 0; back < 48; back += 1) {
    const ms = nowMs - back * 60 * 60 * 1000;
    const { day, hour, minute } = kstParts(ms);
    if (!hours.includes(hour)) continue;
    if (back * 60 + minute < delayMinutes) continue;
    return { day, time: `${pad(hour)}00` };
  }
  throw new Error("발표 시각을 찾지 못함");
}

// 실패 사유만 돌려줌(정상이면 null). 시간 초과·연결 실패도 사유로 남겨 한 번의 실패가 확인 전체를 멈추지 않게 함
// 예외 원문은 요청 주소(키)를 담을 수 있어 오류 이름만 남김
async function call(op, params) {
  const base = op.startsWith("getMid")
    ? "https://apis.data.go.kr/1360000/MidFcstInfoService"
    : "https://apis.data.go.kr/1360000/VilageFcstInfoService_2.0";
  const url = `${base}/${op}?${new URLSearchParams({ ...params, dataType: "JSON", pageNo: "1" })}`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    const json = await res.json().catch(() => null);
    const code = json?.response?.header?.resultCode;
    const total = json?.response?.body?.totalCount ?? 0;
    return res.ok && code === "00" && total > 0
      ? null
      : `http ${res.status} code ${code ?? "?"} rows ${total}`;
  } catch (error) {
    return `exception ${error instanceof Error ? error.name : typeof error}`;
  }
}

// 격자·구역·지점마다 한 번씩 호출. 실패 목록을 돌려줌(키·주소는 남기지 않음)
async function verify(areas, key) {
  const now = Date.now();
  const short = latestBase(now, [2, 5, 8, 11, 14, 17, 20, 23], 10);
  const mid = latestBase(now, [6, 18], 60);
  const sets = codeSets(areas);
  const failures = [];
  const jobs = [
    ...sets.grids.map((g) => async () => {
      const [nx, ny] = g.split(",");
      const why = await call("getVilageFcst", {
        serviceKey: key,
        numOfRows: "10",
        base_date: short.day,
        base_time: short.time,
        nx,
        ny,
      });
      if (why) failures.push(`grid ${g}: ${why}`);
    }),
    ...sets.midLand.map((regId) => async () => {
      const why = await call("getMidLandFcst", {
        serviceKey: key,
        numOfRows: "10",
        regId,
        tmFc: `${mid.day}${mid.time}`,
      });
      if (why) failures.push(`midLand ${regId}: ${why}`);
    }),
    ...sets.midTa.map((regId) => async () => {
      const why = await call("getMidTa", {
        serviceKey: key,
        numOfRows: "10",
        regId,
        tmFc: `${mid.day}${mid.time}`,
      });
      if (why) failures.push(`midTa ${regId}: ${why}`);
    }),
  ];
  // 4개씩 차례로(트래픽 한도·서버 부담)
  for (let i = 0; i < jobs.length; i += 4) {
    await Promise.all(jobs.slice(i, i + 4).map((job) => job()));
  }
  return {
    failures,
    summary: {
      checkedAt: new Date(now).toISOString().replace(/\.\d{3}Z$/, "Z"),
      shortBase: `${short.day}${short.time}`,
      midTmFc: `${mid.day}${mid.time}`,
      grids: sets.grids.length,
      midLand: sets.midLand.length,
      midTa: sets.midTa.length,
      codes: codesDigest(sets),
    },
  };
}

function serialize(areas, verified) {
  return `${JSON.stringify({ _meta: { ...META, verified }, beaches: areas }, null, 2)}\n`;
}

async function main(argv) {
  const areas = buildAreas(readPublicBeaches());
  // 첫 생성이면 파일이 없음 → 이전 실호출 기록 없음. 그 밖의 읽기 오류는 그대로 던짐
  let previous = "";
  try {
    previous = readFileSync(OUT, "utf8");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  // 이전 확인 기록은 같은 코드 묶음일 때만 이어 씀. 대응이 바뀌면 지움(--verify로 다시 확인)
  const sets = codeSets(areas);
  const digest = codesDigest(sets);
  const kept = previous ? (JSON.parse(previous)._meta?.verified ?? null) : null;
  let verified = kept?.codes === digest ? kept : null;
  if (kept && !verified) {
    console.warn("대응이 바뀌어 실호출 확인 기록을 지움: --verify로 다시 확인");
  }
  if (argv.includes("--verify")) {
    const raw = process.env.DATA_GO_KR_SERVICE_KEY;
    if (!raw) throw new Error("DATA_GO_KR_SERVICE_KEY 없음");
    // 인코딩 키(%2B 등)를 그대로 넣으면 URLSearchParams가 한 번 더 인코딩함 → 풀어서 씀
    const key = raw.includes("%") ? decodeURIComponent(raw) : raw;
    const result = await verify(areas, key);
    if (result.failures.length > 0) {
      console.error(result.failures.join("\n"));
      process.exitCode = 1;
      return;
    }
    verified = result.summary;
  }
  const text = serialize(areas, verified);
  if (argv.includes("--check")) {
    if (previous !== text) {
      console.error(
        "data/weather-areas.json이 생성 결과와 다름: node tools/beaches/weather-areas.mjs",
      );
      process.exitCode = 1;
    }
    return;
  }
  writeFileSync(OUT, text);
  console.log(
    `해변 ${Object.keys(areas).length}곳 · 격자 ${sets.grids.length}개 → ${OUT}`,
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main(process.argv.slice(2));
}
