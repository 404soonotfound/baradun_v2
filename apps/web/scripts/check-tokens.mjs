// 토큰 검사 (BRD-22): 대비 기준 + 금지 색. 패키지 없이 node만으로 돌아요.
// 실패하면 종료 코드 1 → CI가 막아요.
import { readFileSync } from "node:fs";

const tokens = JSON.parse(
  readFileSync(new URL("../tokens/tokens.json", import.meta.url), "utf8"),
);

function get(path, mode) {
  if (path.startsWith("#")) return path; // 고정 색 (예: 119 버튼 흰 글자)
  const token = path.split(".").reduce((node, key) => node?.[key], tokens);
  if (!token?.$value) throw new Error(`토큰 없음: ${path}`);
  return mode === "dark"
    ? (token.$extensions?.baradun?.dark ?? token.$value)
    : token.$value;
}

function luminance(hex) {
  const n = hex.replace("#", "");
  const [r, g, b] = [0, 2, 4].map((i) => {
    const c = parseInt(n.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function ratio(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

// [글자·아이콘, 바탕, 최소 대비, 설명, (선택) 이 모드에서만]
// 4.5 = WCAG 1.4.3 본문 글자, 3 = 1.4.11 구분해야 하는 UI 요소
const PAIRS = [
  ["color.text.default", "color.bg.page", 4.5, "본문"],
  ["color.text.default", "color.bg.surface", 4.5, "카드 본문"],
  ["color.text.body", "color.bg.surface", 4.5, "보조 글"],
  ["color.text.body", "color.bg.subtle", 4.5, "보조 면 위 보조 글"],
  ["color.text.muted", "color.bg.surface", 4.5, "메타 글"],
  ["color.text.muted", "color.bg.page", 4.5, "바탕 위 메타 글"],
  ["color.brand.default", "color.bg.surface", 4.5, "링크·글자 버튼"],
  ["color.brand.on", "color.brand.default", 4.5, "주요 버튼 글자"],
  ["color.brand.default", "color.brand.weak", 4.5, "선택된 칩 글자"],
  ["#FFFFFF", "color.danger-call", 4.5, "119 버튼 흰 글자"],
  ["color.danger-call", "color.bg.surface", 4.5, "오류 문구", "light"],
  ["color.status.clear.fg", "color.status.clear.bg", 4.5, "특보 없음 배지"],
  ["color.status.blocked.fg", "color.status.blocked.bg", 4.5, "이용불가 배지"],
  ["color.status.unknown.fg", "color.status.unknown.bg", 4.5, "판단불가 배지"],
  ["color.status.stale.fg", "color.status.stale.bg", 4.5, "관측 지연 배지"],
  ["color.info.fg", "color.info.bg", 4.5, "정보 배지"],
  [
    "color.banner.amber.icon-fg",
    "color.banner.amber.icon-bg",
    3,
    "주황 배너 아이콘",
  ],
  [
    "color.banner.red.icon-fg",
    "color.banner.red.icon-bg",
    3,
    "빨강 배너 아이콘",
  ],
  [
    "color.banner.gray.icon-fg",
    "color.banner.gray.icon-bg",
    3,
    "회색 배너 아이콘",
  ],
];

// 점선 테두리는 상태를 구분하는 보조 표시예요(글자·아이콘이 따로 있음).
// 그래서 실패로 막지 않고 값만 알려 줘요.
const INFO_PAIRS = [
  ["color.status.unknown.border", "color.status.unknown.bg", "판단불가 점선"],
  ["color.status.stale.border", "color.status.stale.bg", "관측 지연 점선"],
];

let failed = 0;
for (const mode of ["light", "dark"]) {
  console.log(`\n[${mode}]`);
  for (const [fg, bg, min, label, only] of PAIRS) {
    if (only && only !== mode) continue;
    const r = ratio(get(fg, mode), get(bg, mode));
    const ok = r >= min;
    if (!ok) failed += 1;
    console.log(
      `${ok ? "통과" : "실패"}  ${r.toFixed(2).padStart(5)} (기준 ${min})  ${label}`,
    );
  }
  for (const [fg, bg, label] of INFO_PAIRS) {
    const r = ratio(get(fg, mode), get(bg, mode));
    console.log(`참고  ${r.toFixed(2).padStart(5)}            ${label}`);
  }
}

// 금지 색: 초록 계열(색상각 90~170°, 채도 있는 색)을 쓰지 않아요 (노션 4장)
function hue(hex) {
  const n = hex.replace("#", "");
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(n.slice(i, i + 2), 16) / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  if (max - min < 0.08) return null; // 회색 계열
  const d = max - min;
  let h =
    max === r
      ? ((g - b) / d) % 6
      : max === g
        ? (b - r) / d + 2
        : (r - g) / d + 4;
  h *= 60;
  return h < 0 ? h + 360 : h;
}
function walk(node, path = []) {
  if (node && typeof node === "object" && "$value" in node) {
    if (node.$type !== "color") return;
    for (const value of [node.$value, node.$extensions?.baradun?.dark].filter(
      Boolean,
    )) {
      const h = hue(value);
      if (h !== null && h >= 90 && h <= 170) {
        failed += 1;
        console.log(`실패  초록 계열 색: ${path.join(".")} = ${value}`);
      }
    }
    return;
  }
  for (const [key, child] of Object.entries(node ?? {})) {
    if (!key.startsWith("$")) walk(child, [...path, key]);
  }
}
walk(tokens);

if (failed > 0) {
  console.error(`\n토큰 검사 실패 ${failed}건`);
  process.exit(1);
}
console.log("\n토큰 검사 통과");
