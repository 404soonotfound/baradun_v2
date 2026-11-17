<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (저장소 루트, npm workspaces로 호이스팅됨) before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# apps/web 규칙

- 정적 내보내기(`output: 'export'`)만 쓴다(G3). Server Action, 요청 기반 Route Handler, ISR, Proxy를 쓰지 않는다.
- 특보·측정 상태는 빌드 HTML에 넣지 않고 브라우저가 `manifest.json` → `status.json`으로 조회한다(G4).
- 화면 분류를 다시 계산하지 않는다. 사유 code → 문구 매핑만 둔다(G1).
- 아키텍처·테스트 방침: Notion 아키텍처 기준 문서 9·9.1장, 결정 기록 11장
- 화면 상태 시나리오: 특보 발효·관측 지연처럼 운영에서 원할 때 볼 수 없는 상태를 띄워 운영 전환 전 QA에 쓴다(결정 기록 D30-5, #550). 값은 E2E 픽스처와 같은 원본(`scripts/scenario-data.mts`)이다.
  - 개발 서버: `npm run dev -w apps/web -- --scenario=<이름>`. 화면에 '예시 데이터' 표시가 나온다.
  - 정적 빌드: `NEXT_PUBLIC_SITE_URL=https://example.test npm run build -w apps/web` 뒤 `npm run scenario:preview -w apps/web -- --scenario=<이름>`(주소 `http://127.0.0.1:3110`, `--lan`이면 같은 Wi-Fi 기기). 데이터는 `out/` 밖 임시 폴더에 쓴다. 운영 주소로 빌드한 결과는 거부한다. 이 경로에는 '예시 데이터' 표시가 없다. 서비스 워커·홈 화면 추가는 운영 주소에서 확인한다.
  - 이름: `mixed`·`warning`·`unknown`·`delayed`·`no-nearby`·`partial-fail`·`all-fail`·`empty`·`maintenance`·`force-update`·`notice`. 실행하면 무엇을 보는지와 먼저 열 해변 주소를 출력한다.
  - 시나리오나 픽스처를 고치면 `scripts/dev-scenario.test.ts`(계약 스키마 통과)와 E2E 전체를 돌린다.
- 화면·동작 관련 PR과 main CI는 `npm run test:e2e:smoke -w apps/web`으로 Chromium 모바일·PC의 핵심 안전 상태·접근성·문의 흐름을 확인한다. PR에서 바뀐 E2E spec은 비핵심 테스트도 실행하고, 공통 픽스처·설정이 바뀌면 전체 스위트를 실행한다. 테스트·개발 지침만 바뀐 PR은 E2E를 건너뛰며 정적 빌드·CSP 검사는 유지한다. 실제 사이트를 올릴 때는 빌드 뒤 전체 Chromium 스위트(`npm run test:e2e -w apps/web`)를 통과해야 한다.
- 운영 주소 스모크(`npm run test:smoke:live -w apps/web -- --base-url <주소>`, `e2e-live/`·`playwright.live.config.ts`, #551)는 배포 뒤 실제 운영 주소를 읽기만 하는 수동 점검이다. CI 필수 검사에 넣지 않는다. 실데이터라 값이 아니라 지켜야 할 조건만 검사한다. 사용법은 `infra/README.md` '배포 뒤 운영 주소 스모크 점검'.
