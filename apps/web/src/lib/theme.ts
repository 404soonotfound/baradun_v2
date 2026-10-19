// 화면 테마 (노션 4장: 시스템·라이트·다크, 기본은 시스템, 그리기 전에 결정)
// 고른 값은 이 기기에만 저장해요. 설정 화면(설정 /settings)에서 이 키에 써요.
export const THEMES = ["system", "light", "dark"] as const;
export type Theme = (typeof THEMES)[number];
export const THEME_STORAGE_KEY = "baradun:theme";

// <html data-theme="light|dark">를 붙이면 그 테마, 없으면 기기 설정을 따라요.
// 화면을 그리기 전에 돌아야 해서 문자열로 <head>에 넣어요. 저장소를 못 읽으면 시스템으로 둬요.
export const THEME_INIT_SCRIPT = `(function(){try{var t=localStorage.getItem(${JSON.stringify(
  THEME_STORAGE_KEY,
)});if(t==="light"||t==="dark"){document.documentElement.setAttribute("data-theme",t)}}catch(e){}})();`;
