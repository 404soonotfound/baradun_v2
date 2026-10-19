// 디자인 토큰 → CSS 변수 (BRD-22)
// 원본: tokens/tokens.json 한 파일 (라이트 = $value, 다크 = $extensions.baradun.dark)
// 결과: src/styles/tokens.css 하나. 만들어지는 파일이라 커밋하지 않음(.gitignore).
// dev·build·storybook 전에 자동으로 실행됨.
//
// 이름 규칙 (노션 4장 '토큰 이름 10/19 확정'·'이름 규칙 보충 10/19 확정')
// 모두 Tailwind 4 테마 이름공간이라 바로 클래스가 됨.
//   색:   --color- + 경로   color.status.clear.bg → --color-status-clear-bg → bg-status-clear-bg
//   글자: --text-{역할}     text.title-xl.*      → --text-title-xl(--font-weight…) → text-title-xl
//   그 외: 그룹-이름        spacing.button → --spacing-button → h-button
//                          radius.card → rounded-card, shadow.card → shadow-card, ease.standard → ease-standard
import StyleDictionary from "style-dictionary";
import { fileHeader, formattedVariables } from "style-dictionary/utils";

const DARK = (token) => token.$extensions?.baradun?.dark;

// Tailwind v4가 알아보는 이름으로 바꿈.
function cssName(token) {
  const [group, ...rest] = token.path;
  if (group === "text") {
    const [role, part] = rest;
    const suffix = {
      size: "",
      weight: "--font-weight",
      "line-height": "--line-height",
      tracking: "--letter-spacing",
    }[part];
    return `text-${role}${suffix}`;
  }
  return token.path.join("-");
}

// 다크 값이 있는 토큰만 "--이름: 값;" 줄로
function darkLines(dictionary, indent) {
  return dictionary.allTokens
    .filter((token) => DARK(token) !== undefined)
    .map((token) => `${indent}--${token.name}: ${DARK(token)};`)
    .join("\n");
}

// @theme static: 쓰지 않는 변수도 모두 내보냄(다크 덮어쓰기·var() 사용 때문).
// --color-*: initial: Tailwind 기본 색(초록 포함)을 지워서 토큰 색만 클래스로 쓰게 함.
// 테마: data-theme이 없으면 기기 설정, light·dark가 있으면 그 값 (시스템·라이트·다크)
async function themedTokens({ dictionary, file }) {
  const header = await fileHeader({ file });
  const light = formattedVariables({
    format: "css",
    dictionary,
    outputReferences: false,
    usesDtcg: true,
  });
  return `${header}@theme static {
  --color-*: initial;
  --color-transparent: transparent;
  --color-current: currentColor;
${light}
}

:root {
  color-scheme: light;
}

@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    color-scheme: dark;
${darkLines(dictionary, "    ")}
  }
}

:root[data-theme="dark"] {
  color-scheme: dark;
${darkLines(dictionary, "  ")}
}
`;
}

const sd = new StyleDictionary({
  source: ["tokens/tokens.json"],
  usesDtcg: true,
  hooks: {
    transforms: {
      "name/baradun": { type: "name", transform: cssName },
    },
    formats: {
      "baradun/tokens-css": themedTokens,
    },
  },
  platforms: {
    css: {
      // 값은 바꾸지 않음(색은 hex, 길이는 px 그대로). 이름만 바꿈.
      transforms: ["name/baradun"],
      buildPath: "src/styles/",
      files: [{ destination: "tokens.css", format: "baradun/tokens-css" }],
    },
  },
});

await sd.buildAllPlatforms();
