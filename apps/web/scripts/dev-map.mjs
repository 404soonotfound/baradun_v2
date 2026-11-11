// 개발 서버·Storybook의 지도 판 파일 (D19-1 · #392)
// 웹은 지도 판 파일(map/<판>/)을 화면과 같은 출처에서만 받음(CSP 'self'). 개발 서버·Storybook에는 map/이 없으므로
// 두 환경의 /map/ 요청만 운영 CloudFront로 넘겨 같은 출처처럼 받게 함(next dev rewrite·Storybook Vite proxy)
// - 운영 CloudFront에 CORS를 열지 않음. 범위 요청(Range)·206·Content-Range·ETag가 그대로 오고 브라우저도 같은 출처라 다 읽음
// - 공개 지도 파일만 읽음(쓰기·인증 없음). 정적 내보내기(next build)에는 들어가지 않음
// - BARADUN_DEV_MAP_ORIGIN으로 다른 사이트 주소를 줄 수 있음(빈 값은 지정하지 않은 것으로 봄)
export const DEV_MAP_ORIGIN_ENV = "BARADUN_DEV_MAP_ORIGIN";
// 운영 사이트 CloudFront 기본 주소(저장소 변수 SITE_URL, infra/README). 도메인을 바꿔도 이 주소는 그대로 열림
export const DEFAULT_DEV_MAP_ORIGIN = "https://d1gam1q4z69v8c.cloudfront.net";

export function devMapOrigin(value = process.env[DEV_MAP_ORIGIN_ENV]) {
  const raw = value || DEFAULT_DEV_MAP_ORIGIN;
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${DEV_MAP_ORIGIN_ENV}가 주소 형식이 아니에요: ${raw}`);
  }
  // 사용자 정보·쿼리·조각·경로가 붙은 값은 조용히 떼지 않고 멈춤(scripts/dev-live.mts parseLiveOrigin과 같은 기준)
  if (
    url.protocol !== "https:" ||
    url.pathname !== "/" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      `${DEV_MAP_ORIGIN_ENV}는 https 사이트 주소(경로 없음)여야 해요: ${raw}`,
    );
  }
  return url.origin;
}
