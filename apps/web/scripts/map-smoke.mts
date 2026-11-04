// OpenFreeMap 스모크 테스트 (BRD-114 · 결정 기록 12장 결정 10, 아키텍처 16.4.3·16.4.5)
// 고정한 것(타일 판·sprite 판)이 아직 그대로 있는지, 고정할 수 없는 것(글꼴)이 응답하는지 실제 서버로 확인함
// - 고정 타일 판이 지워지면 서버는 돌려보내기(3xx)나 오류 없이 최신 판 타일을 200으로 줌(2026-11-04 없는 판 이름으로 확인)
//   → 같은 타일을 '없는 판 이름'으로도 받아 내용이 똑같으면 고정 판이 사라진 것으로 봄(3xx·오류도 실패)
//   판별 TileJSON(/planet/{판})은 쓰지 않음: CDN 캐시에 없으면(MISS) 판과 상관없이 최신 판을 가리켜, 판이 있어도 사라진 것처럼 보임
//   (2026-11-04 CI에서 오탐. 같은 때 고정 판 타일은 최신 판과 내용이 달라 서버에 그대로 있었음)
// - CI 정기 실행(매일)과 배포 전(npm run check:map -w apps/web)에 돌림. 수동 눈 확인만으로 두지 않음
// 위치·사용자 정보는 보내지 않음(공개 타일·글꼴 주소만 부름)
import { readFileSync } from "node:fs";

const TILE_HOST = "https://tiles.openfreemap.org";
const read = (path: string) =>
  readFileSync(new URL(path, import.meta.url), "utf8");

// style.ts는 JSON을 import해서 node로 바로 못 읽음 → 고정 판 이름만 글자로 꺼냄
const pinned = read("../src/lib/map/style.ts").match(
  /PINNED_TILES_VERSION = "([^"]+)"/,
)?.[1];
const styles = ["style-light.json", "style-dark.json"].map(
  (name) => JSON.parse(read(`../src/lib/map/${name}`)) as Style,
);

type Layer = { layout?: Record<string, unknown> };
type Style = { sprite: string; glyphs: string; layers: Layer[] };

const failures: string[] = [];
const fail = (message: string) => {
  failures.push(message);
  console.error(`✗ ${message}`);
};
const pass = (message: string) => console.log(`✓ ${message}`);

// 응답 받기. 돌려보내기는 따라가지 않음(고정 판이 최신으로 바뀌는 것을 잡으려고)
async function get(url: string) {
  try {
    return await fetch(url, {
      redirect: "manual",
      signal: AbortSignal.timeout(20_000),
    });
  } catch (error) {
    fail(`${url} 요청 실패: ${(error as Error).message}`);
    return null;
  }
}

async function expectBody(url: string, what: string) {
  const response = await get(url);
  if (!response) return null;
  if (response.status !== 200) {
    const to = response.headers.get("location");
    fail(`${what}: ${response.status}${to ? ` → ${to}` : ""} (${url})`);
    return null;
  }
  const body = new Uint8Array(await response.arrayBuffer());
  if (body.length === 0) {
    fail(`${what}: 빈 응답 (${url})`);
    return null;
  }
  pass(`${what} (${body.length} bytes)`);
  return body;
}

// 서버에 없는 판 이름(서버가 최신 판으로 대신 줌)
const MISSING_VERSION = "00000000_000000_pt";

function sameBytes(a: Uint8Array, b: Uint8Array) {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

// 좌표 → 타일 번호(웹 메르카토르)
function tileOf(lat: number, lng: number, z: number) {
  const n = 2 ** z;
  const rad = (lat * Math.PI) / 180;
  return {
    x: Math.floor(((lng + 180) / 360) * n),
    y: Math.floor(((1 - Math.asinh(Math.tan(rad)) / Math.PI) / 2) * n),
  };
}

// 표현식이 낼 수 있는 값만 모음(입력·조건·연산자 이름은 뺌). 값은 글자 하나 또는 글꼴 목록(글자 배열)
// 다루지 않는 표현식은 실패로 알림(모르는 채 통과하지 않게)
const OPERATORS = new Set(["literal", "step", "match", "case", "coalesce"]);
function outputs(value: unknown, where: string): unknown[] {
  if (!Array.isArray(value)) return [value];
  const [op, ...args] = value as unknown[];
  if (typeof op !== "string") return [value];
  if (!OPERATORS.has(op)) {
    // 연산자가 아닌 글자 배열 = 글꼴 목록(["Noto Sans Regular"])
    if (
      value.every((item) => typeof item === "string") &&
      !/^[a-z-]+$/.test(op)
    )
      return [value];
    fail(`${where}: 확인하지 못하는 표현식 "${op}"`);
    return [];
  }
  const pick = (keep: (index: number) => boolean) =>
    args
      .filter((_, index) => keep(index))
      .flatMap((arg) => outputs(arg, where));
  const last = args.length - 1;
  switch (op) {
    case "literal":
      return [args[0]];
    case "step": // [입력, 값0, 경계1, 값1, …]
      return pick((index) => index % 2 === 1);
    case "match": // [입력, 라벨1, 값1, …, 기본값]
      return pick((index) => (index >= 2 && index % 2 === 0) || index === last);
    case "case": // [조건1, 값1, …, 기본값]
      return pick((index) => index % 2 === 1 || index === last);
    default: // coalesce
      return pick(() => true);
  }
}

// [1] 고정 타일 판: 동해·서해·남해·제주 표본 좌표, 확대 6·10·14
if (!pinned) fail("style.ts에서 PINNED_TILES_VERSION을 찾지 못함");
else {
  const samples = [
    { name: "강릉", lat: 37.8, lng: 128.92 },
    { name: "대천", lat: 36.31, lng: 126.51 },
    { name: "해운대", lat: 35.159, lng: 129.16 },
    { name: "제주 협재", lat: 33.394, lng: 126.24 },
  ];
  // 최신 판 이름. 고정 판과 같으면 '없는 판'과 내용이 같아도 정상이라 비교하지 않음
  const tilejson = await get(`${TILE_HOST}/planet`);
  const latest = tilejson?.ok
    ? ((await tilejson.json()) as { tiles?: string[] }).tiles?.[0]
    : undefined;
  if (latest === undefined) fail("최신 판 TileJSON을 받지 못함");
  // 참고: 다르면 올릴지 표본 해변 화면을 보고 정함(16.4.3)
  else console.log(`  최신 판: ${latest} · 고정 판: ${pinned}`);
  const compare = latest !== undefined && !latest.includes(`/${pinned}/`);
  // 판 사이에 안 바뀐 타일은 내용이 같을 수 있어, 비교한 표본이 모두 최신과 같을 때만 사라진 것으로 봄
  let compared = 0;
  let replaced = 0;
  for (const sample of samples) {
    for (const z of [6, 10, 14]) {
      const { x, y } = tileOf(sample.lat, sample.lng, z);
      const body = await expectBody(
        `${TILE_HOST}/planet/${pinned}/${z}/${x}/${y}.pbf`,
        `고정 타일 ${pinned} ${sample.name} z${z}`,
      );
      if (!body || !compare) continue;
      const fallback = await get(
        `${TILE_HOST}/planet/${MISSING_VERSION}/${z}/${x}/${y}.pbf`,
      );
      if (!fallback?.ok) continue;
      compared += 1;
      if (sameBytes(body, new Uint8Array(await fallback.arrayBuffer())))
        replaced += 1;
    }
  }
  if (compared > 0 && replaced === compared)
    fail(
      `고정 판 ${pinned}: 표본 ${compared}장이 모두 최신 판과 같음(서버에 고정 판이 없어 최신 판으로 바뀌어 옴)`,
    );
  else if (compared > 0)
    pass(
      `고정 판이 최신 판과 다름 확인(표본 ${compared}장 중 같은 것 ${replaced}장)`,
    );
}

// [2] sprite(판이 주소에 있음): 1x·2x 그림과 목록, 스타일이 쓰는 아이콘이 모두 있는지
for (const sprite of new Set(styles.map((style) => style.sprite))) {
  for (const scale of ["", "@2x"]) {
    await expectBody(`${sprite}${scale}.png`, `sprite${scale}.png`);
    const list = await expectBody(
      `${sprite}${scale}.json`,
      `sprite${scale}.json`,
    );
    if (!list) continue;
    const icons = Object.keys(JSON.parse(new TextDecoder().decode(list)));
    // ""는 '아이콘 없음'(step 표현식의 낮은 확대 단계)
    const used = new Set<string>();
    for (const style of styles)
      for (const layer of style.layers)
        for (const name of outputs(layer.layout?.["icon-image"], "icon-image"))
          if (typeof name === "string" && name !== "") used.add(name);
    const missing = [...used].filter((name) => !icons.includes(name));
    if (missing.length > 0)
      fail(`sprite${scale}.json에 없는 아이콘: ${missing.join(", ")}`);
    else pass(`sprite${scale} 아이콘 확인: ${[...used].join(", ")}`);
  }
}

// [3] 글꼴(판을 고정할 수 없음): 스타일이 쓰는 글꼴마다 첫 범위(라틴 숫자·기호)
// 한글은 브라우저 글꼴로 그려서(localIdeographFontFamily) 서버 글꼴을 받지 않음
// 글꼴 목록은 MapLibre처럼 쉼표로 이어 한 주소로 부름
const fonts = new Set<string>();
for (const style of styles)
  for (const layer of style.layers)
    for (const font of outputs(layer.layout?.["text-font"], "text-font")) {
      if (typeof font === "string") fonts.add(font);
      else if (Array.isArray(font)) fonts.add(font.join(","));
    }
for (const glyphs of new Set(styles.map((style) => style.glyphs))) {
  for (const font of fonts) {
    await expectBody(
      glyphs
        .replace("{fontstack}", encodeURIComponent(font))
        .replace("{range}", "0-255"),
      `글꼴 ${font}`,
    );
  }
}

if (failures.length > 0) {
  console.error(
    `\nOpenFreeMap 확인 실패 ${failures.length}건. 고정 판이 지워졌으면 최신 판을 표본 해변 화면으로 확인한 뒤 style.ts를 올려 주세요.`,
  );
  process.exit(1);
}
console.log("\nOpenFreeMap 확인 통과");
