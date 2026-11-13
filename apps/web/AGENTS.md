<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (저장소 루트, npm workspaces로 호이스팅됨) before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# apps/web 규칙

- 정적 내보내기(`output: 'export'`)만 쓴다(G3). Server Action, 요청 기반 Route Handler, ISR, Proxy를 쓰지 않는다.
- 특보·측정 상태는 빌드 HTML에 넣지 않고 브라우저가 `manifest.json` → `status.json`으로 조회한다(G4).
- 화면 분류를 다시 계산하지 않는다. 사유 code → 문구 매핑만 둔다(G1).
- 아키텍처·테스트 방침: Notion 아키텍처 기준 문서 9·9.1장, 결정 기록 11장
- 화면·동작 관련 PR과 main CI는 `npm run test:e2e:smoke -w apps/web`으로 Chromium 모바일·PC의 핵심 안전 상태·접근성·문의 흐름을 확인한다. PR에서 바뀐 E2E spec은 비핵심 테스트도 실행하고, 공통 픽스처·설정이 바뀌면 전체 스위트를 실행한다. 테스트·개발 지침만 바뀐 PR은 E2E를 건너뛰며 정적 빌드·CSP 검사는 유지한다. 실제 사이트를 올릴 때는 빌드 뒤 전체 Chromium 스위트(`npm run test:e2e -w apps/web`)를 통과해야 한다.
