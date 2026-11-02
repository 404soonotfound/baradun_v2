// CloudFront Function(JS 2.0)에 넣을 코드. 사용자 요청이 S3에 닿기 전에 주소를 고침.
// 대표 주소(BRD-162): 배포 때 사이트 도메인을 넘겼으면, 다른 호스트(CloudFront 기본 주소 등)로 온 페이지 주소 요청은
// 대표 주소의 같은 경로·쿼리로 301 이동함. 도메인이 비어 있으면 이동하지 않음
// 파일 주소(/data/·/_next/·sw.js 등)는 이동하지 않음: 예전 주소에 남은 화면(서비스 워커 저장본)이 바다 정보를 받다가
// 다른 출처로 넘어가 CORS로 막히거나, 서비스 워커 갱신(리디렉트 불가)이 끊기지 않게 함
// 정적 내보내기(trailingSlash: true)는 /en/ 주소를 en/index.html 파일로 만듦.
// S3는 "폴더 주소면 index.html" 규칙을 모르기 때문에 여기서 파일 이름으로 바꿔 줌.
// - 끝이 / 인 주소: index.html을 붙임          /en/            → /en/index.html
// - 마지막 조각에 점(.)이 없는 주소: /index.html  /spots/gyeongpo  → /spots/gyeongpo/index.html
// - 파일 주소(점 있음)는 그대로                   /data/manifest.json

// 스택이 이 자리에 사이트 도메인 매개변수(SiteDomainName)를 넣음. 테스트는 글자로 바꿔 실행함
export const CANONICAL_HOST_PLACEHOLDER = "__CANONICAL_HOST__";

export const rewriteIndexCode = `
var CANONICAL_HOST = '${CANONICAL_HOST_PLACEHOLDER}';

function queryString(querystring) {
  var parts = [];
  for (var key in querystring) {
    var item = querystring[key];
    var values = item.multiValue ? item.multiValue : [item];
    for (var i = 0; i < values.length; i++) {
      parts.push(values[i].value === '' ? key : key + '=' + values[i].value);
    }
  }
  return parts.length > 0 ? '?' + parts.join('&') : '';
}

function handler(event) {
  var request = event.request;
  var uri = request.uri;
  var isPage = uri.endsWith('/') || uri.lastIndexOf('.') < uri.lastIndexOf('/');
  var host = request.headers.host ? request.headers.host.value.toLowerCase() : '';
  if (isPage && CANONICAL_HOST !== '' && host !== CANONICAL_HOST) {
    return {
      statusCode: 301,
      statusDescription: 'Moved Permanently',
      headers: {
        location: { value: 'https://' + CANONICAL_HOST + uri + queryString(request.querystring) },
      },
    };
  }
  if (uri.endsWith('/')) {
    request.uri = uri + 'index.html';
  } else if (isPage) {
    request.uri = uri + '/index.html';
  }
  return request;
}
`;
