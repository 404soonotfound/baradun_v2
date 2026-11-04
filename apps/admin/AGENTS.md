<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (저장소 루트, npm workspaces로 호이스팅됨) before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# apps/admin 규칙

- 운영자 사이트다. 기준은 Notion 아키텍처 18장, 결정 기록 15·16장, 화면 설계서 6장이다.
- 정적 내보내기(`output: 'export'`)만 쓴다(G3). Server Action, 요청 기반 Route Handler, ISR, Proxy를 쓰지 않는다.
- 화면 파일에 데이터·비밀값을 넣지 않는다. 데이터는 로그인 뒤 운영 API(`/ops/*`)로만 받는다. 저장소가 공개라 화면 코드도 공개라는 전제다.
- access·ID token은 메모리에만 두고, refresh token만 그 탭의 sessionStorage(`SESSION_STORE_KEY`)에 최초 인증·활동 시각과 함께 둔다. localStorage·쿠키에는 두지 않는다(D16-A2·D17-11). 새로고침·새 탭은 열려 있는 로그인한 탭에서 BroadcastChannel로 넘겨받고(D17-9), 없으면 그 탭에 둔 refresh token으로 갱신해 이어 간다. 그것도 없거나 실패하면 다시 로그인한다. 토큰 갱신은 Web Locks로 한 탭씩 하고 새 토큰·활동 시각을 다른 탭과 맞춘다.
- 공개 웹(`apps/web`)의 서비스 워커·문의 로컬 저장·분석 도구를 가져오지 않는다(구현 제안 I05).
- 모든 페이지는 검색 노출을 막는다(noindex meta·robots.txt·응답 헤더). `npm run build -w apps/admin`의 postbuild 검사가 확인한다.
- DOM에 HTML 문자열을 넣지 않는다(`dangerouslySetInnerHTML`·`innerHTML` 금지, 린트가 막음). 모든 페이지는 Trusted Types를 켠다: postbuild가 CSP meta에 `require-trusted-types-for 'script'; trusted-types default`와 같은 주소 `/_next/static/` 스크립트만 통과시키는 default 정책을 넣고, E2E는 위반이 있으면 실패한다(BRD-180).
- 화면 문구는 `messages/ko.json` 문구 키로 쓴다.
- 판단 상태(특보 없음·이용불가·판단불가)는 어떤 화면에서도 바꾸지 않는다(G1).
- 화면 안 이동은 `next/link`·`router`로만 한다. `<a href>`로 페이지를 새로 불러오면 메모리의 로그인이 사라진다.
- 로그인은 `src/lib/auth`가 맡는다(결정 기록 D17-1: SRP는 `amazon-cognito-identity-js`, 나머지 Cognito 호출은 공개 API 직접). 운영 API는 `opsFetch`로만 부른다(전용 토큰 헤더·본문 해시).
- 로컬 개발 서버(`npm run dev -w apps/admin`)에서는 로그인 화면의 '로컬 테스트 계정으로 들어가기'로 비밀번호 없이 들어간다(결정 기록 D17-5). 가짜 토큰과 `src/lib/auth/local-dev.ts`의 샘플 응답만 쓰고 실제 Cognito·운영 API는 부르지 않는다. 화면을 만들 때 필요한 `/ops/*` 샘플 응답은 `localOps`에 더한다. 이 코드는 `process.env.NODE_ENV === "development"` 분기 안에서 `import()`로만 불러온다(정적으로 가져오면 배포 묶음에 남아 빌드 결과 검사가 실패한다).
- E2E: 테스트용 풀 값으로 빌드한 뒤 `npm run test:e2e -w apps/admin`(값은 `e2e/fixtures.ts` `TEST_POOL_ENV`). Cognito·`/ops/*`는 가짜 응답이다.
