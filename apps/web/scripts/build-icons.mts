// 앱 아이콘 만들기 (BRD-106 결정 28). icons/*.svg(직접 그린 원본)를 PNG·ICO로 바꿔 public/에 씀
// 실행: npm run icons -w apps/web. 설치된 Playwright chromium으로 SVG를 그림(새 의존성 없음)
// 결과 파일은 커밋함(빌드에서 다시 만들지 않음). 원본을 고치면 다시 실행하고 결과를 함께 커밋
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const WEB = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

// any: 모서리를 둥글린 판(바깥 투명). maskable·Apple touch: 가장자리까지 채운 판(불투명)
export const ICON_SOURCES = {
  any: "icons/icon.svg",
  maskable: "icons/icon-maskable.svg",
} as const;
type Source = keyof typeof ICON_SOURCES;

export const ICON_PNGS: { file: string; source: Source; size: number }[] = [
  { file: "public/icons/icon-192.png", source: "any", size: 192 },
  { file: "public/icons/icon-512.png", source: "any", size: 512 },
  { file: "public/icons/icon-maskable-512.png", source: "maskable", size: 512 },
  { file: "public/icons/apple-touch-icon.png", source: "maskable", size: 180 },
];

// 브라우저 탭 아이콘. 한 ICO 파일에 세 크기를 담음
export const FAVICON = {
  file: "public/favicon.ico",
  source: "any" as Source,
  sizes: [16, 32, 48],
};

// PNG 여러 장을 담은 ICO(Windows 아이콘) 파일. 항목마다 PNG를 그대로 넣음(Vista 이후 형식, 모든 현대 브라우저가 읽음)
// 머리 6바이트(예약 0·종류 1·개수) + 항목 16바이트씩(가로·세로·색 수·예약·면·비트·길이·위치) + PNG 본문
export function ico(images: { size: number; png: Buffer }[]): Buffer {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  let offset = 6 + 16 * images.length;
  const entries = images.map(({ size, png }) => {
    if (size < 1 || size > 256) throw new Error(`ICO 크기 범위 밖: ${size}`);
    const entry = Buffer.alloc(16);
    entry.writeUInt8(size === 256 ? 0 : size, 0); // 256은 0으로 적음
    entry.writeUInt8(size === 256 ? 0 : size, 1);
    entry.writeUInt8(0, 2);
    entry.writeUInt8(0, 3);
    entry.writeUInt16LE(1, 4);
    entry.writeUInt16LE(32, 6);
    entry.writeUInt32LE(png.length, 8);
    entry.writeUInt32LE(offset, 12);
    offset += png.length;
    return entry;
  });
  return Buffer.concat([header, ...entries, ...images.map(({ png }) => png)]);
}

async function main() {
  // 테스트가 이 파일의 목록·ico()만 가져갈 때 브라우저를 띄우지 않게 여기서 불러옴
  const { chromium } = await import("@playwright/test");
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ deviceScaleFactor: 1 });
    const render = async (source: Source, size: number) => {
      const svg = readFileSync(path.join(WEB, ICON_SOURCES[source]));
      const src = `data:image/svg+xml;base64,${svg.toString("base64")}`;
      await page.setViewportSize({ width: size, height: size });
      await page.setContent(
        `<style>html,body{margin:0;background:transparent}img{display:block}</style><img src="${src}" width="${size}" height="${size}" alt="">`,
      );
      await page
        .locator("img")
        .evaluate((img: HTMLImageElement) => img.decode());
      return page.screenshot({
        clip: { x: 0, y: 0, width: size, height: size },
        omitBackground: source === "any", // maskable·Apple touch는 불투명
      });
    };

    for (const { file, source, size } of ICON_PNGS) {
      const out = path.join(WEB, file);
      mkdirSync(path.dirname(out), { recursive: true });
      writeFileSync(out, await render(source, size));
      console.log(`${file} (${size}×${size})`);
    }
    const images = [];
    for (const size of FAVICON.sizes) {
      images.push({ size, png: await render(FAVICON.source, size) });
    }
    writeFileSync(path.join(WEB, FAVICON.file), ico(images));
    console.log(`${FAVICON.file} (${FAVICON.sizes.join("·")})`);
  } finally {
    await browser.close();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
