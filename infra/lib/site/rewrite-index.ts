// CloudFront Function(JS 2.0)에 넣을 코드. 사용자 요청이 S3에 닿기 전에 주소를 고쳐요.
// 정적 내보내기(trailingSlash: true)는 /en/ 주소를 en/index.html 파일로 만들어요.
// S3는 "폴더 주소면 index.html" 규칙을 모르기 때문에 여기서 파일 이름으로 바꿔 줘요.
// - 끝이 / 인 주소: index.html을 붙임          /en/            → /en/index.html
// - 마지막 조각에 점(.)이 없는 주소: /index.html  /spots/gyeongpo  → /spots/gyeongpo/index.html
// - 파일 주소(점 있음)는 그대로                   /data/manifest.json
export const rewriteIndexCode = `
function handler(event) {
  var request = event.request;
  var uri = request.uri;
  if (uri.endsWith('/')) {
    request.uri = uri + 'index.html';
  } else if (uri.lastIndexOf('.') < uri.lastIndexOf('/')) {
    request.uri = uri + '/index.html';
  }
  return request;
}
`;
