// 토큰 검사 (BRD-22): 대비 기준 + 금지 색. 패키지 없이 node만으로 실행됨.
// 실패하면 종료 코드 1 → CI가 막음.
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
  ["color.danger-call-on", "color.danger-call", 4.5, "119 버튼 글자"],
  // 119 카드 빨간 테두리. danger-call은 다크 바탕과 대비가 낮아 다크에서 밝아지는 danger-text를 씀
  ["color.danger-text", "color.bg.surface", 3, "119 카드 테두리"],
  ["color.danger-text", "color.bg.surface", 4.5, "오류 문구"],
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
  // 점선 테두리: 상태를 구분하는 UI 요소라 3 이상 (10/19 확정)
  [
    "color.status.unknown.border",
    "color.status.unknown.bg",
    3,
    "판단불가 점선",
  ],
  ["color.status.stale.border", "color.status.stale.bg", 3, "관측 지연 점선"],
];

// 다크 출시 점검(BRD-44): 화면에서 실제로 겹쳐 쓰는 조합을 추가로 검사
PAIRS.push(
  [
    "color.text.muted",
    "color.bg.subtle",
    4.5,
    "보조 면 위 메타 글(파도 그림 눈금)",
  ],
  ["color.text.muted", "color.brand.weak", 4.5, "고른 목록 행의 메타 글"],
  ["color.bg.surface", "color.text.default", 4.5, "토스트·고른 마커 이름 글자"],
  // 목록 행 상태 글자·왼쪽 색 줄(색 줄은 3이면 되지만 같은 색을 글자에도 씀)
  ["color.status.clear.fg", "color.bg.surface", 4.5, "목록 행 특보 없음 글자"],
  ["color.status.blocked.fg", "color.bg.surface", 4.5, "목록 행 이용불가 글자"],
  ["color.status.unknown.fg", "color.bg.surface", 4.5, "목록 행 판단불가 글자"],
  ["color.status.stale.fg", "color.bg.surface", 4.5, "목록 행 관측 지연 글자"],
  // 지도 마커 채운 원 안 아이콘(채움 = 상태 fg, 아이콘 = bg.surface)
  ["color.bg.surface", "color.status.clear.fg", 3, "특보 없음 마커 아이콘"],
  ["color.bg.surface", "color.status.blocked.fg", 3, "이용불가 마커 아이콘"],
  // 파고 선·미니 그래프(그래픽 3:1). chart는 두 테마 같은 값(노션 7절)
  ["color.chart", "color.bg.surface", 3, "파고 선"],
  ["color.chart", "color.bg.subtle", 3, "파도 그림 앞 물결 선"],
  ["color.chart", "color.brand.weak", 3, "파도 그림 뒤 물결 위 앞 물결 선"],
  // 첫 실행 면책 고지(앰버 면 위 글자·아이콘, BRD-129)
  [
    "color.banner.amber.text",
    "color.banner.amber.icon-bg",
    4.5,
    "앰버 면 위 고지 글자",
  ],
  [
    "color.banner.amber.icon-fg",
    "color.banner.amber.icon-bg",
    3,
    "앰버 면 위 고지 아이콘",
  ],
);

// 참고로만 찍는 조합 (지금은 없음)
const INFO_PAIRS = [];

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

// 금지 색: 초록 계열(색상각 90~170°, 채도 있는 색)을 쓰지 않음 (노션 4장)
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

// 결정 기록 12장 결정 33: 색 토큰은 다크 값이 라이트와 같아도 명시(빠뜨린 것과 같은 값을 구분)
// 결정 34: 그림자 값에는 색을 직접 쓰지 않고 color.shadow.* 변수만(다크에서 바뀌게)
// 그림자 한 겹마다 길이·inset과 color.shadow.* 변수 하나만 허용(이름 색 black·transparent도 막음).
// 가리키는 변수가 실제 color.shadow 토큰인지도 확인(오타면 그림자 전체가 무효가 됨)
function shadowUsesOnlyVars(value) {
  if (typeof value !== "string") return false;
  return value.split(",").every((layer) => {
    const refs = [...layer.matchAll(/var\(--color-shadow-([a-z-]+)\)/g)];
    const rest = layer
      .replace(/var\(--color-shadow-[a-z-]+\)/g, "")
      .replace(/\binset\b|-?\d*\.?\d+(px|rem|em)?/g, "")
      .trim();
    return (
      refs.length === 1 &&
      rest === "" &&
      tokens.color.shadow?.[refs[0][1]]?.$type === "color"
    );
  });
}
function walkDark(node, path = []) {
  if (node && typeof node === "object" && "$value" in node) {
    if (
      node.$type === "color" &&
      node.$extensions?.baradun?.dark === undefined
    ) {
      failed += 1;
      console.log(`실패  다크 값 없음: ${path.join(".")}`);
    }
    if (node.$type === "shadow" && !shadowUsesOnlyVars(node.$value)) {
      failed += 1;
      console.log(`실패  그림자에 직접 쓴 색: ${path.join(".")}`);
    }
    return;
  }
  for (const [key, child] of Object.entries(node ?? {})) {
    if (!key.startsWith("$")) walkDark(child, [...path, key]);
  }
}
walkDark(tokens);

// 결정 32: 10/16 다크 초안(노션 4장 7절 표)에 다크 값이 없던 토큰 14개(처음에 13개로 셌던 목록).
// 노션 4장 7절 '다크 값 확인 토큰 14개'·아키텍처 9.1과 같은 목록. 색은 다크 값, 그림자는 다크에서 바뀌는 색 변수를 씀
const DARK_REVIEWED = [
  "color.banner.amber.border",
  "color.banner.amber.icon-bg",
  "color.banner.amber.icon-fg",
  "color.banner.red.border",
  "color.banner.red.icon-bg",
  "color.banner.red.icon-fg",
  "color.banner.gray.border",
  "color.banner.gray.icon-bg",
  "color.banner.gray.icon-fg",
  "color.chart", // 다크도 같은 값
  "color.danger-call", // 다크도 같은 값
  "shadow.card",
  "shadow.raised",
  "shadow.floating",
];
for (const path of DARK_REVIEWED) {
  const token = path.split(".").reduce((node, key) => node?.[key], tokens);
  // 그림자 값은 위 walkDark가 color.shadow.* 변수만 쓰는지 검사함. 여기서는 빠진 토큰만 확인
  const ok =
    token?.$type === "shadow" ||
    token?.$extensions?.baradun?.dark !== undefined;
  if (!ok) {
    failed += 1;
    console.log(`실패  다크 확인 토큰 14개 중 다크 값 없음: ${path}`);
  }
}

// 결정 34: 다크 카드 경계선은 border/default 다크 값을 재사용(한쪽만 바뀌지 않게)
if (get("color.shadow.edge", "dark") !== get("color.border.default", "dark")) {
  failed += 1;
  console.log("실패  color.shadow.edge 다크 값이 color.border.default와 다름");
}

if (failed > 0) {
  console.error(`\n토큰 검사 실패 ${failed}건`);
  process.exit(1);
}
console.log("\n토큰 검사 통과");
