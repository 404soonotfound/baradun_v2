import { DEVICE_KEYS } from "@/lib/device-keys";
import { serializeInlineScriptValue } from "@/lib/display-init";
import { LOCALES } from "@/lib/i18n";
import { NOTICE_VERSION } from "@/lib/notice-version";

// 그리기 전 자리 잡기 힌트 (BRD-39 · Core Web Vitals CLS)
// 정적 HTML은 기기 저장값을 모르는 상태(위치 확인 중·최근 본 없음·언어 안내 없음)로 그려지고, 수화 뒤 실제 값으로 바뀌며 화면이 밀림.
// 그리기 전에 기기 저장값만 읽어 <html>에 힌트를 붙이고, globals.css가 그 힌트로 바뀔 자리를 미리 잡음.
// 힌트는 자리만 잡음. 무엇을 보일지는 늘 React가 실제 값으로 정함(틀리면 한 번 밀릴 뿐 내용은 맞음)
// 서버 부품(root-document)이 읽어야 해서 React 훅이 없는 이 파일에 둠(lib/display-init.ts와 같은 틀)

// 기본 지역 저장 키(lib/region.ts). 값이 있으면 지역·전국을 고른 것
export const REGION_STORAGE_KEY = "baradun:region";
// 고른 언어 저장 키(lib/language-choice.ts). 값이 있으면 언어 안내를 다시 띄우지 않음
export const LANGUAGE_STORAGE_KEY = "baradun:language";
// '위치 사용' 스위치 저장 키(lib/location.ts). 값 "off"만 저장(없으면 켜짐 = 기본값)
export const LOCATION_SWITCH_KEY = "baradun:location-switch";
// 지난 방문에서 위치를 썼는지(lib/location.ts가 상태가 정해질 때 씀). "on"·"off"만. 좌표·권한 원문은 저장하지 않음
export const LOCATION_HINT_KEY = "baradun:location-hint";
// 첫 실행 고지 확인 기록(lib/onboarding.ts). noticeVersion이 같으면 이미 확인한 기기
export const ONBOARDING_STORAGE_KEY = "baradun:onboarding";

// <html>에 붙이는 힌트
//   data-onboarded: 현재 고지 버전을 이미 확인했거나(/guide·/terms 포함) 첫 실행 안내를 미리 그리지 않음
//   data-location-hint="off|on": 지난 방문에 위치를 못 썼으면(첫 방문 포함) off → 홈 '위치 없이 보고 있어요' 자리·지역 목록 자리
//   data-region-chosen: 기본 지역(전국 포함)을 고름 → 홈이 위치와 관계없이 지역 목록
//   data-recent="1|2": 최근 본 해변 1곳·2곳 이상 → 홈 최근 본 자리
//   data-language-notice="ko|en": 첫 방문 언어 안내를 띄울 언어(lib/language-choice.ts noticeTarget과 같은 규칙)
// 저장소를 못 읽으면 저장 힌트는 붙이지 않음(자리를 잡지 않을 뿐 화면은 그대로). 언어 안내는 기기 언어만으로도 판단
export const LAYOUT_HINT_SCRIPT = `(function(){var h=document.documentElement,L=${serializeInlineScriptValue(
  LOCALES,
)},V=${serializeInlineScriptValue(
  NOTICE_VERSION,
)},c=null;try{if(typeof location!=="undefined"&&/\\/(guide|terms)\\/?$/.test(location.pathname)){h.setAttribute("data-onboarded","")}}catch(e){}try{var s=localStorage;try{var b=JSON.parse(s.getItem(${serializeInlineScriptValue(
  ONBOARDING_STORAGE_KEY,
)})||"null");if(b&&typeof b==="object"&&b.noticeVersion===V&&typeof b.acknowledgedAt==="string"&&typeof b.locationStepDone==="boolean"){h.setAttribute("data-onboarded","")}}catch(e){}try{var r=JSON.parse(s.getItem(${serializeInlineScriptValue(
  DEVICE_KEYS.recent,
)})||"[]"),n=0;if(Array.isArray(r)){for(var i=0;i<r.length;i++){if(typeof r[i]==="string")n++}}if(n){h.setAttribute("data-recent",n>1?"2":"1")}}catch(e){}h.setAttribute("data-location-hint",s.getItem(${serializeInlineScriptValue(
  LOCATION_SWITCH_KEY,
)})!=="off"&&s.getItem(${serializeInlineScriptValue(
  LOCATION_HINT_KEY,
)})==="on"?"on":"off");if(s.getItem(${serializeInlineScriptValue(
  REGION_STORAGE_KEY,
)})!==null){h.setAttribute("data-region-chosen","")}c=s.getItem(${serializeInlineScriptValue(
  LANGUAGE_STORAGE_KEY,
)})}catch(e){}try{var g=navigator.languages&&navigator.languages[0]||navigator.language||"",d=g.toLowerCase().split("-")[0];if(L.indexOf(c)<0&&L.indexOf(d)>=0&&d!==h.getAttribute("lang")){h.setAttribute("data-language-notice",d)}}catch(e){}})();`;

// 언어 안내를 고르거나 띄울 필요가 없어지면 힌트를 뗌(남아 있으면 안내 없는 빈 자리가 높이를 잡은 채 남음)
export function clearLanguageNoticeHint() {
  document.documentElement.removeAttribute("data-language-notice");
}
