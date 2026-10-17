# 바라던 바다 V2

해변별 기상특보와 해양 관측값이 지금 확인되는지를 보여 주는 서비스입니다. 서비스는 확인 가능한 사실만 판단하고, 바다에 들어갈지는 사용자가 현장 안내와 함께 판단합니다.

> 최종 판단은 현장 통제와 안전요원 안내가 우선입니다.

## 구조

| 경로 | 내용 |
|---|---|
| `apps/web` | Next.js 정적 사이트 (CloudFront + S3로 배포) |
| `services` | 수집·게시 Lambda (TypeScript) — 예정 |
| `packages/contracts` | 프론트·백엔드가 공유하는 JSON Schema 계약 — 예정 |
| `infra` | AWS CDK (TypeScript) — 예정 |
| `data/beaches` | 해변 목록 — 예정 |

## 실행

Node.js와 npm이 필요합니다. 루트에서 실행합니다.

```bash
npm install
npm run dev        # 개발 서버
npm run build      # 정적 빌드
npm run lint
npm run typecheck
```

## 기준 문서

요구사항과 아키텍처 결정(ADR 포함)의 원본은 Notion 'V2 공식 문서 인덱스 · 현재 기준'입니다. 이 저장소의 문서와 다르면 Notion을 따릅니다. 작업 규칙은 [AGENTS.md](AGENTS.md)에 있습니다.
