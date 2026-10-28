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
// theme-color(결정 35): viewport가 넣은 <meta name="theme-color"> 줄(기기 설정별 media 두 줄)의 값을 모두 실제로 그리는
// 테마의 바탕색으로 맞춤 → media와 상관없이 고른 테마 색. data-theme(설정 변경·다른 탭)·기기 설정 변경을 따라 다시 맞추고,
// 화면 이동 때 Next가 <head>의 줄을 다시 그려도(새 줄·값 되돌림) 다시 맞춤. 같은 값이면 쓰지 않음(관찰이 반복되지 않게)
// 테마 규칙은 lib/theme.ts resolveTheme과 같음(light·dark면 그 값, 그 밖은 기기 설정). 실패하면 media 두 줄(기기 설정)이 남음
const THEME_SCRIPT = `try{var c=${JSON.stringify(THEME_COLORS)},q=window.matchMedia?window.matchMedia("(prefers-color-scheme: dark)"):null,u=function(){var t=h.getAttribute("data-theme"),v=c[t==="light"||t==="dark"?t:q&&q.matches?"dark":"light"],l=d.querySelectorAll('meta[name="theme-color"]');for(var i=0;i<l.length;i++){if(l[i].getAttribute("content")!==v){l[i].setAttribute("content",v)}}};u();var o=new MutationObserver(u);o.observe(h,{attributes:true,attributeFilter:["data-theme"]});o.observe(d.head,{childList:true,subtree:true,attributes:true,attributeFilter:["name","content"]});if(q&&q.addEventListener){q.addEventListener("change",u)}else if(q&&q.addListener){q.addListener(u)}}catch(e){}`;

export const DISPLAY_INIT_SCRIPT = `(function(){var d=document,h=d.documentElement;try{var s=localStorage,t=s.getItem(${JSON.stringify(
  THEME_STORAGE_KEY,
)});if(t==="light"||t==="dark"){h.setAttribute("data-theme",t)}if(s.getItem(${JSON.stringify(
  MOTION_STORAGE_KEY,
)})==="off"){h.setAttribute("data-motion","reduce")}}catch(e){}${THEME_SCRIPT}})();`;
