// 사이트 주소: hreflang·canonical·공유 미리보기 절대 주소의 기준(metadataBase) (BRD-102 결정 14)
// 운영 기본 주소를 두지 않음. 값이 없거나 형식이 틀리면 빌드(정적 생성)를 멈춤
// 개발은 .env.development, CI·E2E 빌드는 워크플로가 명시한 테스트 값, 운영 배포는 저장소 변수 SITE_URL을 씀

const NAME = "NEXT_PUBLIC_SITE_URL";

// 사이트 루트 절대 주소만 받음: http(s), 사용자 정보·경로·검색어·조각 없음, 앞뒤 공백 없음
export function parseSiteUrl(raw: string | undefined): URL {
  if (raw === undefined || raw.trim() === "") {
    throw new Error(
      `${NAME}이 비어 있음. 사이트 루트 절대 주소를 지정해야 함 (예: ${NAME}=https://example.test npm run build -w apps/web)`,
    );
  }
  const shown = JSON.stringify(raw);
  if (raw !== raw.trim()) {
    throw new Error(`${NAME} 앞뒤에 공백이 있음: ${shown}`);
  }
  if (!URL.canParse(raw)) {
    throw new Error(`${NAME}이 절대 주소가 아님: ${shown}`);
  }
  const url = new URL(raw);
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(`${NAME}은 http(s) 주소여야 함: ${shown}`);
  }
  if (url.username !== "" || url.password !== "") {
    throw new Error(`${NAME}에 사용자 정보를 넣지 않음: ${shown}`);
  }
  // 정적 사이트를 도메인 루트에 올림(CloudFront + S3). 하위 경로면 hreflang 주소가 실제 경로와 어긋남
  if (url.pathname !== "/" || url.search !== "" || url.hash !== "") {
    throw new Error(
      `${NAME}은 경로·검색어·조각 없는 사이트 루트여야 함: ${shown}`,
    );
  }
  return new URL(url.origin); // 빈 "?"·"#"까지 떼어 루트 주소만 남김
}

// 두 루트 레이아웃이 metadataBase로 씀. process.env.NEXT_PUBLIC_SITE_URL을 그대로 적어야 빌드 때 값이 들어감
export function siteUrl(): URL {
  return parseSiteUrl(process.env.NEXT_PUBLIC_SITE_URL);
}
