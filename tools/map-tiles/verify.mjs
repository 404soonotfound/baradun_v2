#!/usr/bin/env node
// 한국 지도 판 검사 (결정 기록 D19-1 · #392). 의존성 없이 node만 씀
// 사용:
//   node tools/map-tiles/verify.mjs --dir <build.sh 출력>/<판>        만든 파일(형식·필수 자산) 확인
//   node tools/map-tiles/verify.mjs --site <사이트 주소> [--version <판>]  실제 CloudFront 경로 확인
//     판을 주지 않으면 웹이 쓰는 판(apps/web/src/lib/map/style.ts의 MAP_VERSION)을 확인함
// 실제 경로 확인: READY.txt 판 일치 → PMTiles 범위 요청(206·Content-Range·헤더) → sprite·글꼴 응답
// 하나라도 틀리면(파일 없음·다른 판·범위 무시·HTML 대체 응답) 종료 코드 1
// 위치·사용자 정보는 보내지 않음(공개 지도 파일 주소만 부름). 쓰기·AWS 권한 없음
import {
  existsSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  closeSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const MAP_SRC = join(ROOT, "apps/web/src/lib/map");

export const VERSION_PATTERN = /^\d{8}-\d{4}$/;
export const SPRITES = ["ofm.json", "ofm.png", "ofm@2x.json", "ofm@2x.png"];
// 글꼴 범위: 라틴(0-255)과 한글 첫 범위. 스타일이 실제로 부르는 범위 중 대표 둘
export const GLYPH_RANGES = ["0-255", "44032-44287"];
export const HEADER_BYTES = 127; // PMTiles v3 고정 헤더 길이
// 지도 파일이 반드시 덮어야 하는 곳(해변이 있는 끝 지점): 제주 남쪽, 고성 북쪽, 울릉도, 백령도
export const MUST_COVER = [
  { name: "제주 남쪽", lon: 126.55, lat: 33.24 },
  { name: "강원 고성", lon: 128.47, lat: 38.45 },
  { name: "울릉도", lon: 130.9, lat: 37.5 },
  { name: "백령도", lon: 124.68, lat: 37.95 },
];

// 웹이 쓰는 판 이름. style.ts는 JSON을 import해서 node로 바로 못 읽음 → 글자로 꺼냄
export function webMapVersion(
  source = readFileSync(join(MAP_SRC, "style.ts"), "utf8"),
) {
  return source.match(/export const MAP_VERSION = "([^"]+)"/)?.[1] ?? null;
}

// 스타일 JSON이 부르는 글꼴(text-font) 목록
export function styleFonts(styles) {
  const fonts = new Set();
  for (const style of styles) {
    for (const layer of style.layers ?? []) {
      const font = layer.layout?.["text-font"];
      if (Array.isArray(font)) font.forEach((name) => fonts.add(name));
    }
  }
  return [...fonts].sort();
}

function readStyles() {
  return ["style-light.json", "style-dark.json"].map((name) =>
    JSON.parse(readFileSync(join(MAP_SRC, name), "utf8")),
  );
}

// PMTiles v3 헤더 읽기. 형식이 틀리면 이유를 문자열로 돌려줌
export function parseHeader(bytes) {
  if (bytes.length < HEADER_BYTES)
    return `헤더가 ${HEADER_BYTES}바이트보다 짧음(${bytes.length})`;
  const magic = new TextDecoder().decode(bytes.subarray(0, 7));
  if (magic !== "PMTiles")
    return `PMTiles 파일이 아님(앞 7바이트 ${JSON.stringify(magic)})`;
  if (bytes[7] !== 3) return `PMTiles 판이 3이 아님(${bytes[7]})`;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u64 = (at) => Number(view.getBigUint64(at, true));
  const e7 = (at) => view.getInt32(at, true) / 1e7;
  return {
    rootOffset: u64(8),
    rootLength: u64(16),
    tileType: bytes[99], // 1 = MVT(벡터 타일)
    minZoom: bytes[100],
    maxZoom: bytes[101],
    bounds: {
      minLon: e7(102),
      minLat: e7(106),
      maxLon: e7(110),
      maxLat: e7(114),
    },
  };
}

// 헤더 내용이 우리 지도에 맞는지(벡터 타일, 확대 0~14, 한국 끝 지점 포함)
export function headerProblems(header) {
  if (typeof header === "string") return [header];
  const problems = [];
  if (header.tileType !== 1)
    problems.push(`타일 형식이 MVT(1)가 아님(${header.tileType})`);
  if (header.minZoom !== 0 || header.maxZoom !== 14) {
    problems.push(
      `확대 범위가 0~14가 아님(${header.minZoom}~${header.maxZoom})`,
    );
  }
  if (!(header.rootOffset >= HEADER_BYTES && header.rootLength > 0)) {
    problems.push(
      `루트 목록 위치가 이상함(${header.rootOffset}, ${header.rootLength})`,
    );
  }
  const b = header.bounds;
  for (const point of MUST_COVER) {
    if (!(
      b.minLon <= point.lon &&
      point.lon <= b.maxLon &&
      b.minLat <= point.lat &&
      point.lat <= b.maxLat
    )) {
      problems.push(
        `지도 범위가 ${point.name}을 덮지 않음(${JSON.stringify(b)})`,
      );
    }
  }
  return problems;
}

// 범위 요청 응답 판정: 206, Content-Range가 요청한 범위와 같고 전체 길이가 있음, 본문 길이 일치, 압축 안 됨
export function rangeProblems(
  { status, contentRange, contentEncoding, bodyLength },
  start,
  end,
) {
  const problems = [];
  if (status !== 206) problems.push(`범위 요청에 206이 아님(${status})`);
  const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(contentRange ?? "");
  if (!match) {
    problems.push(`Content-Range 형식이 틀림(${contentRange ?? "없음"})`);
  } else {
    const [, from, to, total] = match.map(Number);
    if (from !== start || to !== end)
      problems.push(
        `Content-Range가 요청 범위와 다름(${contentRange}, 요청 ${start}-${end})`,
      );
    if (!(total > end))
      problems.push(`Content-Range 전체 길이가 이상함(${contentRange})`);
  }
  if (contentEncoding)
    problems.push(
      `압축돼 있음(Content-Encoding: ${contentEncoding}) → 범위가 어긋남`,
    );
  if (bodyLength !== end - start + 1)
    problems.push(
      `본문 길이가 범위와 다름(${bodyLength}, 기대 ${end - start + 1})`,
    );
  return problems;
}

const PNG = [0x89, 0x50, 0x4e, 0x47];
export function assetProblems(name, bytes, contentType) {
  if (contentType !== undefined && /text\/html/.test(contentType ?? ""))
    return [`HTML 응답(${contentType}) → 파일이 없을 때의 대체 화면`];
  if (bytes.length === 0) return ["빈 파일"];
  if (name.endsWith(".png")) {
    return PNG.every((b, i) => bytes[i] === b) ? [] : ["PNG가 아님"];
  }
  if (name.endsWith(".json")) {
    try {
      const json = JSON.parse(new TextDecoder().decode(bytes));
      return json && typeof json === "object" && Object.keys(json).length > 0
        ? []
        : ["sprite 목록이 비어 있음"];
    } catch {
      return ["JSON이 아님"];
    }
  }
  return [];
}

// ── 만든 파일 확인 ──
export function verifyDir(dir, fonts) {
  const failures = [];
  const file = join(dir, "korea.pmtiles");
  if (!existsSync(file)) {
    failures.push(`${file} 없음`);
  } else {
    const fd = openSync(file, "r");
    const head = new Uint8Array(HEADER_BYTES);
    readSync(fd, head, 0, HEADER_BYTES, 0);
    closeSync(fd);
    failures.push(
      ...headerProblems(parseHeader(head)).map((p) => `korea.pmtiles: ${p}`),
    );
  }
  for (const name of SPRITES) {
    const path = join(dir, "sprites", name);
    if (!existsSync(path)) failures.push(`sprites/${name} 없음`);
    else
      failures.push(
        ...assetProblems(name, readFileSync(path)).map(
          (p) => `sprites/${name}: ${p}`,
        ),
      );
  }
  for (const font of fonts) {
    const fontDir = join(dir, "fonts", font);
    const count = existsSync(fontDir)
      ? readdirSync(fontDir).filter((n) => n.endsWith(".pbf")).length
      : 0;
    if (count !== 256)
      failures.push(`fonts/${font}: 범위 파일이 256개가 아님(${count})`);
  }
  return failures;
}

// ── 실제 CloudFront 경로 확인 ──
async function fetchBytes(url, headers = {}) {
  const response = await fetch(url, {
    headers,
    redirect: "manual",
    signal: AbortSignal.timeout(20_000),
  });
  const body = new Uint8Array(await response.arrayBuffer());
  return { response, body };
}

export async function verifySite(site, version, fonts, log = console.log) {
  const failures = [];
  const base = `${site.replace(/\/+$/, "")}/map/${version}`;
  const step = async (what, fn) => {
    try {
      const problems = await fn();
      if (problems.length === 0) log(`✓ ${what}`);
      for (const p of problems) failures.push(`${what}: ${p}`);
    } catch (error) {
      failures.push(`${what}: 요청 실패(${error.message})`);
    }
  };

  await step(`READY.txt = ${version}`, async () => {
    const { response, body } = await fetchBytes(`${base}/READY.txt`);
    if (response.status !== 200)
      return [`${response.status} → 다 올린 판이 아님(파일 없음)`];
    const text = new TextDecoder().decode(body).trim();
    return text === version
      ? []
      : [`판 이름이 다름(${JSON.stringify(text.slice(0, 40))})`];
  });

  let header = null;
  await step("korea.pmtiles 헤더 범위 요청", async () => {
    const end = HEADER_BYTES - 1;
    const { response, body } = await fetchBytes(`${base}/korea.pmtiles`, {
      range: `bytes=0-${end}`,
    });
    const problems = rangeProblems(
      {
        status: response.status,
        contentRange: response.headers.get("content-range"),
        contentEncoding: response.headers.get("content-encoding"),
        bodyLength: body.length,
      },
      0,
      end,
    );
    if (problems.length > 0) return problems;
    header = parseHeader(body);
    return headerProblems(header);
  });

  if (header && typeof header !== "string") {
    // 헤더가 가리키는 루트 목록도 같은 파일에서 범위로 받아짐(가운데 범위도 잘림 없이)
    await step("korea.pmtiles 루트 목록 범위 요청", async () => {
      const start = header.rootOffset;
      const end = start + header.rootLength - 1;
      const { response, body } = await fetchBytes(`${base}/korea.pmtiles`, {
        range: `bytes=${start}-${end}`,
      });
      return rangeProblems(
        {
          status: response.status,
          contentRange: response.headers.get("content-range"),
          contentEncoding: response.headers.get("content-encoding"),
          bodyLength: body.length,
        },
        start,
        end,
      );
    });
  }

  for (const name of SPRITES) {
    await step(`sprites/${name}`, async () => {
      const { response, body } = await fetchBytes(`${base}/sprites/${name}`);
      if (response.status !== 200) return [`${response.status}`];
      return assetProblems(
        name,
        body,
        response.headers.get("content-type") ?? "",
      );
    });
  }
  for (const font of fonts) {
    for (const range of GLYPH_RANGES) {
      await step(`fonts/${font}/${range}.pbf`, async () => {
        const { response, body } = await fetchBytes(
          `${base}/fonts/${encodeURIComponent(font)}/${range}.pbf`,
        );
        if (response.status !== 200) return [`${response.status}`];
        return assetProblems(
          `${range}.pbf`,
          body,
          response.headers.get("content-type") ?? "",
        );
      });
    }
  }
  return failures;
}

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const fonts = styleFonts(readStyles());
  if (fonts.length === 0)
    throw new Error("스타일 JSON에서 글꼴(text-font)을 찾지 못했어요");
  const dir = arg("dir");
  const site = arg("site");
  let failures;
  if (dir) {
    failures = verifyDir(dir, fonts);
  } else if (site) {
    const version = arg("version") ?? webMapVersion();
    if (!version || !VERSION_PATTERN.test(version)) {
      throw new Error(`판 이름이 YYYYMMDD-HHMM이 아니에요: ${version}`);
    }
    console.log(`지도 판 ${version} 확인: ${site}`);
    failures = await verifySite(site, version, fonts);
  } else {
    throw new Error("--dir <폴더> 또는 --site <사이트 주소>를 주세요");
  }
  for (const f of failures) console.error(`✗ ${f}`);
  if (failures.length > 0) {
    console.error(`\n지도 판 확인 실패 ${failures.length}건`);
    process.exit(1);
  }
  console.log("\n지도 판 확인 통과");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    console.error(`::error::${error.message}`);
    process.exit(1);
  });
}
