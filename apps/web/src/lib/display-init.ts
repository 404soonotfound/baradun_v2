import { THEME_COLORS } from "@/lib/viewport";

// 그리기 전에 <html>에 붙이는 화면 설정 (BRD-22 테마 · BRD-36 화면 움직임 · BRD-106 theme-color)
// 서버 부품(root-document)이 읽어야 해서 React 훅이 없는 이 파일에 둠. 저장소·훅은 lib/theme.ts·lib/motion.ts

// 화면 테마 저장 키. 값은 "light"·"dark", 없으면 기기 설정(시스템)
export const THEME_STORAGE_KEY = "baradun:theme";
// 화면 움직임 저장 키. 값 "off"만 저장(없으면 켜짐)
export const MOTION_STORAGE_KEY = "baradun:motion";

// <html data-theme="light|dark">를 붙이면 그 테마, 없으면 기기 설정을 따름
// <html data-motion="reduce">면 globals.css가 기기의 '동작 줄이기'와 같은 규칙을 적용
// 화면을 그리기 전에 돌아야 해서 문자열로 넣음. 저장소를 못 읽으면 시스템 테마·움직임 켜짐
// theme-color(결정 35): viewport가 넣은 <meta name="theme-color"> 두 줄(라이트 색·다크 색)의 content는 그대로 두고 media만 바꿈
// - 밝게·어둡게를 고르면 그 색 줄은 media="all", 다른 줄은 "not all" → 기기 설정과 상관없이 고른 테마 색
// - 기기 설정(data-theme 없음·모르는 값)이면 원래 media(prefers-color-scheme)로 되돌림 → 기기 변경은 브라우저가 따라감
// content를 바꾸면 React가 hydration 때 content로 줄을 찾지 못해 줄을 새로 만들거나 엇갈려 가져가므로 손대지 않음
// 줄의 색(content)으로 어느 테마 줄인지 알아봄. 토큰 색이 아닌 줄은 건드리지 않음. 같은 값이면 쓰지 않음
// 관찰: <html> data-theme(설정 변경·다른 탭)과, 화면 이동 때 Next가 <head>에 새로 넣는 theme-color 줄만
// 테마 규칙은 lib/theme.ts resolveTheme과 같음(light·dark면 그 값, 그 밖은 기기 설정). 실패하면 원래 media 두 줄이 남음
const THEME_SCRIPT = `try{var c=${JSON.stringify(THEME_COLORS)},a=function(m){var k=m.getAttribute("content");k=k===c.light?"light":k===c.dark?"dark":null;if(!k)return;var t=h.getAttribute("data-theme"),v=t==="light"||t==="dark"?(t===k?"all":"not all"):"(prefers-color-scheme: "+k+")";if(m.getAttribute("media")!==v){m.setAttribute("media",v)}},u=function(){var l=d.querySelectorAll('meta[name="theme-color"]');for(var i=0;i<l.length;i++){a(l[i])}};u();new MutationObserver(u).observe(h,{attributes:true,attributeFilter:["data-theme"]});new MutationObserver(function(r){for(var i=0;i<r.length;i++){for(var j=0,n=r[i].addedNodes;j<n.length;j++){if(n[j].nodeName==="META"&&n[j].getAttribute("name")==="theme-color"){a(n[j])}}}}).observe(d.head,{childList:true})}catch(e){}`;

export const DISPLAY_INIT_SCRIPT = `(function(){var d=document,h=d.documentElement;try{var s=localStorage,t=s.getItem(${JSON.stringify(
  THEME_STORAGE_KEY,
)});if(t==="light"||t==="dark"){h.setAttribute("data-theme",t)}if(s.getItem(${JSON.stringify(
  MOTION_STORAGE_KEY,
)})==="off"){h.setAttribute("data-motion","reduce")}}catch(e){}${THEME_SCRIPT}})();`;
