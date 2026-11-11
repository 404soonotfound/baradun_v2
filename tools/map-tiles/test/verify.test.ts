import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  HEADER_BYTES,
  SPRITES,
  assetProblems,
  headerProblems,
  parseHeader,
  rangeProblems,
  styleFonts,
  verifyDir,
  verifySite,
  webMapVersion,
} from "../verify.mjs";

// 지도 판 검사 (D19-1 · #392). 파일 없음·다른 판·범위 무시·HTML 대체 응답은 모두 실패여야 함

const VERSION = "20261111-0654";
const ROOT_OFFSET = 127;
const ROOT_LENGTH = 50;
const TOTAL = 1000;

// PMTiles v3 헤더(한국 범위, 벡터 타일, 확대 0~14)
function header({ tileType = 1, maxZoom = 14, minLon = 124.5 } = {}) {
  const bytes = new Uint8Array(HEADER_BYTES);
  bytes.set(new TextEncoder().encode("PMTiles"), 0);
  bytes[7] = 3;
  const view = new DataView(bytes.buffer);
  view.setBigUint64(8, BigInt(ROOT_OFFSET), true);
  view.setBigUint64(16, BigInt(ROOT_LENGTH), true);
  bytes[99] = tileType;
  bytes[100] = 0;
  bytes[101] = maxZoom;
  view.setInt32(102, Math.round(minLon * 1e7), true);
  view.setInt32(106, Math.round(33.0 * 1e7), true);
  view.setInt32(110, Math.round(131.9 * 1e7), true);
  view.setInt32(114, Math.round(38.7 * 1e7), true);
  return bytes;
}

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]);
const SPRITE_JSON = new TextEncoder().encode('{"beach":{"x":0}}');

describe("PMTiles 헤더", () => {
  it("한국 범위 벡터 타일 헤더는 통과", () => {
    expect(headerProblems(parseHeader(header()))).toEqual([]);
  });

  it("PMTiles가 아니거나 짧으면 실패", () => {
    expect(
      headerProblems(parseHeader(new TextEncoder().encode("<!doctype html>"))),
    ).toHaveLength(1);
    const html = new Uint8Array(HEADER_BYTES);
    html.set(new TextEncoder().encode("<html>"));
    expect(headerProblems(parseHeader(html))[0]).toMatch(/PMTiles 파일이 아님/);
  });

  it("타일 형식·확대 범위·지도 범위가 다르면 실패", () => {
    expect(headerProblems(parseHeader(header({ tileType: 2 })))[0]).toMatch(
      /MVT/,
    );
    expect(headerProblems(parseHeader(header({ maxZoom: 12 })))[0]).toMatch(
      /0~14/,
    );
    // 서쪽 끝이 백령도보다 동쪽이면 백령도를 덮지 않음
    expect(headerProblems(parseHeader(header({ minLon: 125 })))[0]).toMatch(
      /백령도/,
    );
  });
});

describe("범위 요청 응답", () => {
  const ok = {
    status: 206,
    contentRange: `bytes 0-126/${TOTAL}`,
    contentEncoding: null,
    bodyLength: 127,
  };

  it("206·요청과 같은 Content-Range·본문 길이면 통과", () => {
    expect(rangeProblems(ok, 0, 126)).toEqual([]);
  });

  it("범위를 무시한 200 전체 응답은 실패", () => {
    const problems = rangeProblems(
      {
        status: 200,
        contentRange: null,
        contentEncoding: null,
        bodyLength: TOTAL,
      },
      0,
      126,
    );
    expect(problems.join()).toMatch(/206이 아님/);
    expect(problems.join()).toMatch(/Content-Range 형식/);
  });

  it("다른 범위·전체 길이 없음·압축은 실패", () => {
    expect(
      rangeProblems(
        { ...ok, contentRange: `bytes 0-99/${TOTAL}` },
        0,
        126,
      ).join(),
    ).toMatch(/요청 범위와 다름/);
    expect(
      rangeProblems({ ...ok, contentRange: "bytes 0-126/*" }, 0, 126).join(),
    ).toMatch(/형식/);
    expect(
      rangeProblems({ ...ok, contentEncoding: "gzip" }, 0, 126).join(),
    ).toMatch(/압축/);
    expect(rangeProblems({ ...ok, bodyLength: 100 }, 0, 126).join()).toMatch(
      /본문 길이/,
    );
  });
});

describe("sprite·글꼴 응답", () => {
  it("HTML 대체 화면·빈 파일·형식 오류는 실패", () => {
    expect(
      assetProblems("ofm.png", PNG, "text/html; charset=utf-8")[0],
    ).toMatch(/HTML/);
    expect(
      assetProblems("0-255.pbf", new Uint8Array(), "application/x-protobuf"),
    ).toEqual(["빈 파일"]);
    expect(assetProblems("ofm.png", SPRITE_JSON, "image/png")).toEqual([
      "PNG가 아님",
    ]);
    expect(
      assetProblems(
        "ofm.json",
        new TextEncoder().encode("{}"),
        "application/json",
      )[0],
    ).toMatch(/비어/);
    expect(assetProblems("ofm.json", PNG, "application/json")).toEqual([
      "JSON이 아님",
    ]);
  });

  it("올바른 파일은 통과", () => {
    expect(assetProblems("ofm.png", PNG, "image/png")).toEqual([]);
    expect(assetProblems("ofm.json", SPRITE_JSON, "application/json")).toEqual(
      [],
    );
  });
});

describe("웹이 쓰는 판·글꼴", () => {
  it("style.ts의 MAP_VERSION을 읽고, 실제 저장소 값은 판 형식이다", () => {
    expect(webMapVersion('export const MAP_VERSION = "20260101-0000";')).toBe(
      "20260101-0000",
    );
    expect(webMapVersion("const other = 1;")).toBeNull();
    expect(webMapVersion()).toMatch(/^\d{8}-\d{4}$/);
  });

  it("스타일들이 부르는 글꼴을 중복 없이 모음", () => {
    const layer = (font: string[]) => ({ layout: { "text-font": font } });
    expect(
      styleFonts([
        { layers: [layer(["B"]), layer(["A"])] },
        { layers: [layer(["A"]), {}] },
      ]),
    ).toEqual(["A", "B"]);
  });
});

describe("만든 파일 확인(--dir)", () => {
  let dir = "";
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function makeDir({ fontCount = 256, skipSprite = "" } = {}) {
    dir = mkdtempSync(join(tmpdir(), "map-verify-"));
    writeFileSync(join(dir, "korea.pmtiles"), header());
    mkdirSync(join(dir, "sprites"));
    for (const name of SPRITES) {
      if (name !== skipSprite)
        writeFileSync(
          join(dir, "sprites", name),
          name.endsWith(".png") ? PNG : SPRITE_JSON,
        );
    }
    mkdirSync(join(dir, "fonts", "Noto Sans Regular"), { recursive: true });
    for (let i = 0; i < fontCount; i++)
      writeFileSync(
        join(
          dir,
          "fonts",
          "Noto Sans Regular",
          `${i * 256}-${i * 256 + 255}.pbf`,
        ),
        "x",
      );
  }

  it("필수 자산이 다 있으면 통과", () => {
    makeDir();
    expect(verifyDir(dir, ["Noto Sans Regular"])).toEqual([]);
  });

  it("sprite·글꼴 범위·글꼴 폴더가 빠지면 실패", () => {
    makeDir({ fontCount: 200, skipSprite: "ofm@2x.png" });
    const failures = verifyDir(dir, ["Noto Sans Regular", "Noto Sans Bold"]);
    expect(failures).toContain("sprites/ofm@2x.png 없음");
    expect(failures).toContain(
      "fonts/Noto Sans Regular: 범위 파일이 256개가 아님(200)",
    );
    expect(failures).toContain(
      "fonts/Noto Sans Bold: 범위 파일이 256개가 아님(0)",
    );
  });

  it("지도 파일이 없으면 실패", () => {
    makeDir();
    rmSync(join(dir, "korea.pmtiles"));
    expect(verifyDir(dir, ["Noto Sans Regular"])[0]).toMatch(
      /korea\.pmtiles 없음/,
    );
  });
});

describe("실제 경로 확인(--site)", () => {
  afterEach(() => vi.unstubAllGlobals());

  type Answer = {
    status: number;
    body?: Uint8Array | string;
    headers?: Record<string, string>;
  };
  // 경로별 응답. 기본은 정상 판
  function stubSite(
    override: (path: string, range: string | null) => Answer | undefined = () =>
      undefined,
  ) {
    const requests: string[] = [];
    vi.stubGlobal(
      "fetch",
      async (url: string, init: { headers?: Record<string, string> }) => {
        const path = new URL(url).pathname;
        const range = init.headers?.range ?? null;
        requests.push(`${path}${range ? ` ${range}` : ""}`);
        const answer = override(path, range) ?? normal(path, range);
        const body =
          typeof answer.body === "string"
            ? new TextEncoder().encode(answer.body)
            : (answer.body ?? new Uint8Array());
        return new Response(body, {
          status: answer.status,
          headers: answer.headers,
        });
      },
    );
    return requests;
  }
  function normal(path: string, range: string | null): Answer {
    if (path.endsWith("/READY.txt"))
      return { status: 200, body: `${VERSION}\n` };
    if (path.endsWith("/korea.pmtiles")) {
      const [start, end] = (
        range?.match(/bytes=(\d+)-(\d+)/)?.slice(1) ?? ["0", "126"]
      ).map(Number);
      const file = new Uint8Array(TOTAL);
      file.set(header(), 0);
      return {
        status: 206,
        body: file.slice(start, end + 1),
        headers: { "content-range": `bytes ${start}-${end}/${TOTAL}` },
      };
    }
    if (path.endsWith(".png"))
      return {
        status: 200,
        body: PNG,
        headers: { "content-type": "image/png" },
      };
    if (path.endsWith(".json"))
      return {
        status: 200,
        body: SPRITE_JSON,
        headers: { "content-type": "application/json" },
      };
    return {
      status: 200,
      body: "glyphs",
      headers: { "content-type": "application/x-protobuf" },
    };
  }
  const run = () =>
    verifySite(
      "https://site.example/",
      VERSION,
      ["Noto Sans Regular"],
      () => {},
    );

  it("정상 판은 통과하고, 헤더·루트 목록을 범위로 받고 글꼴 이름을 주소에 맞게 바꿈", async () => {
    const requests = stubSite();
    expect(await run()).toEqual([]);
    expect(requests).toContain(`/map/${VERSION}/korea.pmtiles bytes=0-126`);
    expect(requests).toContain(
      `/map/${VERSION}/korea.pmtiles bytes=${ROOT_OFFSET}-${ROOT_OFFSET + ROOT_LENGTH - 1}`,
    );
    expect(requests).toContain(
      `/map/${VERSION}/fonts/Noto%20Sans%20Regular/0-255.pbf`,
    );
  });

  it("READY.txt가 없으면(다 올리지 않은 판·없는 판) 실패", async () => {
    stubSite((path) =>
      path.endsWith("/READY.txt")
        ? {
            status: 404,
            body: "<html>",
            headers: { "content-type": "text/html" },
          }
        : undefined,
    );
    expect((await run()).join()).toMatch(/READY\.txt.*404/);
  });

  it("READY.txt의 판 이름이 다르면 실패", async () => {
    stubSite((path) =>
      path.endsWith("/READY.txt")
        ? { status: 200, body: "20260101-0000\n" }
        : undefined,
    );
    expect((await run()).join()).toMatch(/판 이름이 다름/);
  });

  it("범위를 무시하고 전체 파일을 200으로 주면 실패", async () => {
    stubSite((path) =>
      path.endsWith("/korea.pmtiles")
        ? { status: 200, body: new Uint8Array(TOTAL) }
        : undefined,
    );
    expect((await run()).join()).toMatch(/206이 아님/);
  });

  it("sprite·글꼴이 없으면(404·HTML 대체) 실패", async () => {
    stubSite((path) =>
      path.includes("/fonts/")
        ? { status: 404 }
        : path.endsWith("ofm.png")
          ? {
              status: 200,
              body: "<html>",
              headers: { "content-type": "text/html" },
            }
          : undefined,
    );
    const failures = (await run()).join("\n");
    expect(failures).toMatch(/fonts\/Noto Sans Regular\/0-255\.pbf: 404/);
    expect(failures).toMatch(/sprites\/ofm\.png: HTML/);
  });

  it("요청이 실패하면(시간 초과·연결 끊김) 실패", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new Error("timeout");
    });
    expect((await run()).join()).toMatch(/요청 실패\(timeout\)/);
  });
});
