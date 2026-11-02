// 운영 사이트 판별 (BRD-143 · BRD-144). 지금은 GA만 따름. noindex·robots·sitemap(BRD-144)도 이 함수 하나를 따르게 둠
// 기준: 빌드 때 받은 NEXT_PUBLIC_SITE_URL(lib/site-url.ts)의 origin이 운영 주소 상수와 같을 때만 운영
// 로컬(dev·live)·CI·E2E(example.test)·값 없음·틀린 값은 모두 비운영 → GA 없음, 전체 noindex, robots Disallow, sitemap 비움
// 새 NEXT_PUBLIC_* 변수를 만들지 않음(워크플로가 웹 빌드에 넘기는 공개 변수는 두 개로 고정, infra/test/workflows.test.ts)
import { parseSiteUrl } from "@/lib/site-url";

// 운영 주소(V1과 같은 도메인). 바뀌면 여기만 고침. 저장소 변수 SITE_URL(deploy.yml)도 같은 값이어야 운영 빌드가 됨
export const PRODUCTION_SITE_ORIGIN = "https://baradun.app";

// Google Analytics 측정 ID(G-로 시작, GTM- 컨테이너 아님). 운영 빌드에서만 쓰임(components/analytics)
export const GA_MEASUREMENT_ID = "G-1JV7N1JSHP";

// 사이트 주소 값이 운영 주소인지. 비었거나 틀린 값은 운영이 아님(빌드 자체는 siteUrl()이 멈춤)
export function isProductionSiteUrl(raw: string | undefined): boolean {
  try {
    return parseSiteUrl(raw).origin === PRODUCTION_SITE_ORIGIN;
  } catch {
    return false;
  }
}

// process.env.NEXT_PUBLIC_SITE_URL을 그대로 적어야 빌드 때 값이 들어감(site-url.ts와 같음)
export function isProductionSite(): boolean {
  return isProductionSiteUrl(process.env.NEXT_PUBLIC_SITE_URL);
}
