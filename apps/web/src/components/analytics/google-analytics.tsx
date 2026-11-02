"use client";

import { usePathname } from "next/navigation";
import Script from "next/script";
import { useEffect, useRef, useState } from "react";

// Google Analytics(gtag.js) 페이지 조회 (BRD-143). 운영 빌드에서만 root-document가 그림(lib/site-env.ts isProductionSite)
// - 인라인 초기화 스크립트를 두지 않음: dataLayer·gtag 정의와 config를 effect에서 함(번들 코드라 CSP 'self', 해시 불필요)
// - config: 자동 page_view 끔(send_page_view: false), Google 신호·광고 개인화 끔
// - page_view는 usePathname의 경로만 보냄. 쿼리·해시를 넣지 않음(/search?q= 검색어가 GA로 가면 안 됨). window.location.href를 쓰지 않음
// - config보다 먼저 set으로 page_location·page_path·page_referrer를 경로까지만 고정함. gtag.js가 스스로 보내는 이벤트
//   (user_engagement, 브라우저 기록 변경 등)도 document.location 대신 이 값을 쓰게 하기 위함
// - 주소에 쿼리가 있으면(/search/?q=…) 초기화(config)를 미루고 다음 경로에서 함. gtag.js는 config 때 document.location의
//   검색어를 읽어 향상된 측정 view_search_results(search_term)를 보내는데 page_location을 고정해도 막히지 않음(운영 빌드 확인).
//   GA 관리의 '향상된 측정 › 사이트 검색' 설정과 상관없이 검색어가 나가지 않게 코드에서 막음. 그 화면의 조회는 세지 않음
// - config는 gtag.js가 불러와진 뒤(onReady)에만 넣음. 미리 dataLayer에 쌓으면 gtag.js가 늦게 불러와질 때 그 시점의
//   document.location(그사이 /search/?q=로 옮겨 간 주소)을 읽어 검색어가 나갈 수 있음. 불러온 뒤에는 넣는 즉시 처리됨
// - page_referrer: 첫 조회는 document.referrer(경로까지만), 화면 이동 뒤에는 직전 경로. document.referrer는 화면 이동으로 바뀌지 않음
// - 이벤트는 page_view만. 기기 위치·검색어·문의 내용·자유 입력은 어떤 이벤트에도 넣지 않음
// - CSP: script-src·img-src·connect-src의 GA 출처는 infra/lib/site/security-headers.ts·e2e/static-server.mjs·scripts/csp-meta.mts

declare global {
  interface Window {
    dataLayer?: unknown[];
    gtag?: (...args: unknown[]) => void;
  }
}

const GTAG_ORIGIN = "https://www.googletagmanager.com";

// 공식 스니펫과 같은 모양: gtag.js는 배열이 아닌 arguments 객체([object Arguments])만 명령으로 처리함
function ensureGtag(): (...args: unknown[]) => void {
  window.dataLayer ??= [];
  window.gtag ??= function gtag() {
    // eslint-disable-next-line prefer-rest-params -- 배열로 바꾸면 gtag.js가 명령으로 보지 않음
    (window.dataLayer ??= []).push(arguments);
  };
  return window.gtag;
}

// 주소에서 origin·경로만 남김(쿼리·해시 제거). 못 읽는 값은 빈 글자
function originAndPath(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return "";
  }
}

export function GoogleAnalytics({ measurementId }: { measurementId: string }) {
  const pathname = usePathname();
  const [loaded, setLoaded] = useState(false);
  const configured = useRef(false);
  const previousPath = useRef<string | null>(null);

  useEffect(() => {
    if (!loaded || !pathname) return;
    const gtag = ensureGtag();
    const origin = window.location.origin;
    const page = {
      page_location: `${origin}${pathname}`,
      page_path: pathname,
      // 같은 사이트의 검색 화면(/search/?q=)에서 넘어온 경우 referrer에 검색어가 남지 않게 경로까지만
      page_referrer:
        previousPath.current === null
          ? originAndPath(document.referrer)
          : `${origin}${previousPath.current}`,
    };
    if (!configured.current) {
      // 쿼리가 있는 주소에서는 초기화하지 않음(위 설명). 다음 조회의 referrer는 이 경로
      if (window.location.search !== "") {
        previousPath.current = pathname;
        return;
      }
      configured.current = true;
      gtag("set", page);
      gtag("js", new Date());
      gtag("config", measurementId, {
        send_page_view: false,
        allow_google_signals: false,
        allow_ad_personalization_signals: false,
        ...page,
      });
    } else {
      gtag("set", page);
    }
    gtag("event", "page_view", page);
    previousPath.current = pathname;
  }, [loaded, measurementId, pathname]);

  return (
    <Script
      src={`${GTAG_ORIGIN}/gtag/js?id=${encodeURIComponent(measurementId)}`}
      strategy="afterInteractive"
      // onReady: 처음 불러올 때와, 이미 불러온 뒤 부품이 다시 붙을 때 모두 불림(onLoad는 처음만)
      onReady={() => setLoaded(true)}
    />
  );
}
