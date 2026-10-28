import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import manifest from "../src/app/manifest";
import { HEAD_ICONS, MANIFEST_ICONS } from "../src/lib/app-icons";
import tokens from "../tokens/tokens.json";

import { FAVICON, ICON_PNGS, ICON_SOURCES, ico } from "./build-icons.mjs";

// 앱 아이콘 (BRD-106 결정 28): 원본 SVG·만든 파일·매니페스트·<head> 연결이 서로 맞는지
const WEB = fileURLToPath(new URL("..", import.meta.url));
const read = (file: string) => readFileSync(path.join(WEB, file));
const publicFile = (url: string) => path.join("public", url);

// PNG 머리(IHDR): 가로·세로·색 형식(2 = RGB 불투명, 6 = RGBA)
function pngInfo(png: Buffer) {
  expect(png.subarray(0, 8)).toEqual(
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  );
  expect(png.toString("latin1", 12, 16)).toBe("IHDR");
  return {
    width: png.readUInt32BE(16),
    height: png.readUInt32BE(20),
    colorType: png.readUInt8(25),
  };
}

// ICO 항목: 크기와 담긴 PNG
function icoEntries(file: Buffer) {
  expect(file.readUInt16LE(0)).toBe(0);
  expect(file.readUInt16LE(2)).toBe(1);
  return Array.from({ length: file.readUInt16LE(4) }, (_, index) => {
    const at = 6 + index * 16;
    const width = file.readUInt8(at) || 256;
    const length = file.readUInt32LE(at + 8);
    const offset = file.readUInt32LE(at + 12);
    return { width, png: file.subarray(offset, offset + length) };
  });
}

// 아이콘에 쓰기로 한 토큰(라이트 값): 바탕 brand/weak, 물결 brand/default·chart (원본 SVG 주석과 같음)
const ICON_COLORS = {
  plate: tokens.color.brand.weak.$value,
  wave: tokens.color.brand.default.$value,
  waveMid: tokens.color.chart.$value,
};

describe("원본 SVG", () => {
  it.each(Object.values(ICON_SOURCES))(
    "%s: 정한 토큰 색만 쓰고 외부 자산·글꼴이 없음",
    (file) => {
      const svg = read(file).toString("utf8");
      const used = new Set(
        [...svg.matchAll(/#[0-9A-Fa-f]{3,8}\b/g)].map(([hex]) =>
          hex.toUpperCase(),
        ),
      );
      // 다른 토큰 색(상태색 등)이나 토큰 밖 색이 섞이면 실패
      expect([...used].sort()).toEqual(
        Object.values(ICON_COLORS)
          .map((hex) => hex.toUpperCase())
          .sort(),
      );
      // 판(첫 rect) 바탕은 brand/weak
      expect(svg).toMatch(
        new RegExp(`<rect [^>]*fill="${ICON_COLORS.plate}"`, "i"),
      );
      // 다른 파일·주소를 불러오지 않음(xmlns 선언만 허용), 글자(글꼴)를 쓰지 않음
      expect(svg.replace('xmlns="http://www.w3.org/2000/svg"', "")).not.toMatch(
        /https?:|href=|<image|<text|font-family|@import/,
      );
    },
  );
});

describe("만든 파일", () => {
  it.each(ICON_PNGS)("$file: $size×$size", ({ file, source, size }) => {
    const info = pngInfo(read(file));
    expect(info.width).toBe(size);
    expect(info.height).toBe(size);
    // maskable·Apple touch는 투명한 곳이 없어야 함(알파 채널 없음)
    expect(info.colorType).toBe(source === "maskable" ? 2 : 6);
  });

  it("favicon.ico에 16·32·48 PNG가 들어 있음", () => {
    const entries = icoEntries(read(FAVICON.file));
    expect(entries.map((entry) => entry.width)).toEqual(FAVICON.sizes);
    for (const { width, png } of entries) {
      const info = pngInfo(png);
      expect([info.width, info.height]).toEqual([width, width]);
    }
  });
});

describe("ico()", () => {
  it("256은 0으로 적고, 범위 밖 크기는 거절함", () => {
    const png = Buffer.from("png");
    const file = ico([
      { size: 16, png },
      { size: 256, png },
    ]);
    expect(file.readUInt16LE(4)).toBe(2);
    expect(file.readUInt8(6)).toBe(16);
    expect(file.readUInt8(6 + 16)).toBe(0);
    // 두 번째 PNG는 첫 PNG 바로 뒤
    expect(file.readUInt32LE(6 + 12)).toBe(6 + 32);
    expect(file.readUInt32LE(6 + 16 + 12)).toBe(6 + 32 + png.length);
    expect(file.length).toBe(6 + 32 + png.length * 2);
    expect(() => ico([{ size: 0, png }])).toThrow("범위 밖");
    expect(() => ico([{ size: 257, png }])).toThrow("범위 밖");
  });
});

describe("매니페스트·<head> 연결", () => {
  it("매니페스트에 any 192·512와 maskable 512가 따로 있음", () => {
    expect(manifest().icons).toEqual(MANIFEST_ICONS);
    expect(
      MANIFEST_ICONS.map(({ sizes, purpose }) => `${purpose} ${sizes}`),
    ).toEqual(["any 192x192", "any 512x512", "maskable 512x512"]);
  });

  it.each(MANIFEST_ICONS)(
    "매니페스트 $src: 파일이 있고 적은 크기·형식과 같음",
    ({ src, sizes, type }) => {
      const file = publicFile(src);
      expect(existsSync(path.join(WEB, file))).toBe(true);
      const { width, height } = pngInfo(read(file));
      expect(`${width}x${height}`).toBe(sizes);
      expect(type).toBe("image/png");
    },
  );

  it("<head>의 favicon·Apple touch 아이콘 파일이 있고 크기가 맞음", () => {
    const icons = HEAD_ICONS as {
      icon: { url: string; sizes: string }[];
      apple: { url: string; sizes: string }[];
    };
    const [favicon] = icons.icon;
    expect(publicFile(favicon!.url)).toBe(FAVICON.file);
    expect(favicon!.sizes).toBe(
      FAVICON.sizes.map((size) => `${size}x${size}`).join(" "),
    );
    const [apple] = icons.apple;
    const info = pngInfo(read(publicFile(apple!.url)));
    expect(`${info.width}x${info.height}`).toBe(apple!.sizes);
    expect(apple!.sizes).toBe("180x180");
    expect(info.colorType).toBe(2);
  });
});
