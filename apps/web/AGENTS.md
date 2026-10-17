<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (저장소 루트, npm workspaces로 호이스팅됨) before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# apps/web 규칙

- 정적 내보내기(`output: 'export'`)만 쓴다(G3). Server Action, 요청 기반 Route Handler, ISR, Proxy를 쓰지 않는다.
- 특보·측정 상태는 빌드 HTML에 넣지 않고 브라우저가 `manifest.json` → `status.json`으로 조회한다(G4).
- 화면 분류를 다시 계산하지 않는다. 사유 code → 문구 매핑만 둔다(G1).
- 아키텍처·테스트 방침: Notion 아키텍처 기준 문서 9·9.1장, 결정 기록 11장
