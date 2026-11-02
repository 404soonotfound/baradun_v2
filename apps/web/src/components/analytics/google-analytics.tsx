"use client";

import { usePathname } from "next/navigation";
import Script from "next/script";
import { useEffect } from "react";

// Google Analytics(gtag.js) 페이지 조회 (BRD-143). 운영 빌드에서만 root-document가 그림(lib/site-env.ts isProductionSite)
// - 인라인 초기화 스크립트를 두지 않음: dataLayer·gtag 정의와 config를 effect에서 함(번들 코드라 CSP 'self', 해시 불필요)
// - config: 자동 page_view 끔(send_page_view: false), Google 신호·광고 개인화 끔
// - page_view는 usePathname의 경로만 보냄. 쿼리·해시를 넣지 않음(/search?q= 검색어가 GA로 가면 안 됨). window.location.href를 쓰지 않음
//   set으로 page_location·page_path·page_referrer를 먼저 고정해 gtag.js가 스스로 보내는 이벤트(user_engagement 등)도 document.location을 쓰지 않게 함
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

  useEffect(() => {
    const gtag = ensureGtag();
    gtag("js", new Date());
    gtag("config", measurementId, {
      send_page_view: false,
      allow_google_signals: false,
      allow_ad_personalization_signals: false,
    });
  }, [measurementId]);

  useEffect(() => {
    if (!pathname) return;
    const gtag = ensureGtag();
    const page = {
      page_location: `${window.location.origin}${pathname}`,
      page_path: pathname,
      // 같은 사이트의 검색 화면(/search/?q=)에서 넘어온 경우 referrer에 검색어가 남지 않게 경로까지만
      page_referrer: originAndPath(document.referrer),
    };
    gtag("set", page);
    gtag("event", "page_view", page);
  }, [pathname]);

  return (
    <Script
      src={`${GTAG_ORIGIN}/gtag/js?id=${encodeURIComponent(measurementId)}`}
      strategy="afterInteractive"
    />
  );
}
