// 그리기 전에 <html>에 붙이는 운영자 화면 테마 설정 (#459)
// 서버 부품(layout.tsx)이 읽어야 해서 React 훅이 없는 이 파일에 둠. 저장소·훅은 lib/theme.ts

export const THEME_STORAGE_KEY = "baradun-admin:theme";

const INLINE_SCRIPT_ESCAPES: Record<string, string> = {
  "<": "\\u003C",
  ">": "\\u003E",
  "&": "\\u0026",
  "/": "\\u002F",
  "\u2028": "\\u2028",
  "\u2029": "\\u2029",
};

// JSON 값이 HTML의 script 태그를 닫거나 자바스크립트 줄을 끝내지 못하게 함
export function serializeInlineScriptValue(value: unknown): string {
  const json = JSON.stringify(value);
  if (json === undefined) {
    throw new Error("인라인 스크립트 값을 직렬화하지 못함");
  }
  return json.replace(
    /[<>&/\u2028\u2029]/g,
    (character) => INLINE_SCRIPT_ESCAPES[character]!,
  );
}

// <html data-theme="light|dark">를 그리기 전에 붙여 깜빡임을 막음. system이거나 잘못된 값이면 속성을 두지 않음
export const THEME_INIT_SCRIPT = `(function(){try{var t=localStorage.getItem(${serializeInlineScriptValue(
  THEME_STORAGE_KEY,
)});if(t==="light"||t==="dark"){document.documentElement.setAttribute("data-theme",t)}}catch(e){}})();`;
