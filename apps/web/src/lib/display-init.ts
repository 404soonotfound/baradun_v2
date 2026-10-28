// 그리기 전에 <html>에 붙이는 화면 설정 (BRD-22 테마 · BRD-36 화면 움직임)
// 서버 부품(root-document)이 읽어야 해서 React 훅이 없는 이 파일에 둠. 저장소·훅은 lib/theme.ts·lib/motion.ts

// 화면 테마 저장 키. 값은 "light"·"dark", 없으면 기기 설정(시스템)
export const THEME_STORAGE_KEY = "baradun:theme";
// 화면 움직임 저장 키. 값 "off"만 저장(없으면 켜짐)
export const MOTION_STORAGE_KEY = "baradun:motion";

// <html data-theme="light|dark">를 붙이면 그 테마, 없으면 기기 설정을 따름
// <html data-motion="reduce">면 globals.css가 기기의 '동작 줄이기'와 같은 규칙을 적용
// 화면을 그리기 전에 돌아야 해서 문자열로 넣음. 저장소를 못 읽으면 시스템 테마·움직임 켜짐
export const DISPLAY_INIT_SCRIPT = `(function(){try{var s=localStorage,h=document.documentElement,t=s.getItem(${JSON.stringify(
  THEME_STORAGE_KEY,
)});if(t==="light"||t==="dark"){h.setAttribute("data-theme",t)}if(s.getItem(${JSON.stringify(
  MOTION_STORAGE_KEY,
)})==="off"){h.setAttribute("data-motion","reduce")}}catch(e){}})();`;
