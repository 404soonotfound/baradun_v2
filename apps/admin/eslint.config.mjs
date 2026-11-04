import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const TRUSTED_TYPES_MESSAGE =
  "운영자 사이트는 Trusted Types를 켜서 HTML 문자열을 넣을 수 없음. React 요소로 그림";
// HTML 문자열을 받는 속성(대입)과 메서드(호출)
const HTML_PROPS = "innerHTML|outerHTML|srcdoc";
const HTML_CALLS =
  "insertAdjacentHTML|createContextualFragment|setHTMLUnsafe|parseFromString|write|writeln";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Trusted Types(BRD-180): DOM에 HTML 문자열을 넣지 않음. 브라우저가 막으므로 화면 코드(src)에서 미리 막음
  // 대입·호출만 막고 읽기(el.outerHTML 확인 등)는 막지 않음
  {
    files: ["src/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-syntax": [
        "error",
        ...[
          "JSXAttribute[name.name=/^(dangerouslySetInnerHTML|srcDoc)$/]",
          `AssignmentExpression > MemberExpression.left[property.name=/^(${HTML_PROPS})$/]`,
          `AssignmentExpression > MemberExpression.left[computed=true][property.value=/^(${HTML_PROPS})$/]`,
          `CallExpression > MemberExpression.callee[property.name=/^(${HTML_CALLS})$/]`,
          `CallExpression > MemberExpression.callee[computed=true][property.value=/^(${HTML_CALLS})$/]`,
          "CallExpression[callee.property.name='setAttribute'][arguments.0.value=/^srcdoc$/i]",
        ].map((selector) => ({ selector, message: TRUSTED_TYPES_MESSAGE })),
      ],
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
]);

export default eslintConfig;
