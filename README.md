# 바라던 바다 V2

해변별 기상특보와 해양 관측값이 지금 확인되는지를 보여 주는 서비스입니다. 서비스는 확인 가능한 사실만 판단하고, 바다에 들어갈지는 사용자가 현장 안내와 함께 판단합니다.

> 최종 판단은 현장 통제와 안전요원 안내가 우선입니다.

## 구조

| 경로 | 내용 |
|---|---|
| `apps/web` | Next.js 정적 사이트 (CloudFront + S3로 배포). 디자인 토큰·문구 키·Storybook 포함 |
| `services` | 수집·게시 Lambda (TypeScript). 특보 정규화·상태 저장소 등 `src/core`부터 구현 중 |
| `packages/contracts` | 프론트·백엔드가 공유하는 JSON Schema 계약과 검사 스크립트 |
| `infra` | AWS CDK (TypeScript) — S3·CloudFront·DynamoDB·Scheduler·OIDC |
| `data/beaches` | 해변 목록 원본 (해변 하나 = 파일 하나, 규칙은 [data/beaches/README.md](data/beaches/README.md)) |
| `data` | 해변 부가 정보(`beach-meta.json`)와 커버리지 매트릭스(`beach-coverage.csv`) |
| `tools/beaches` | 해변 데이터 생성기·검사 도구 |
| `.github/workflows` | CI(`ci.yml`)와 사이트 배포(`deploy.yml`, OIDC 임시 키) |

## 실행

Node.js 버전은 [.nvmrc](.nvmrc)를 따릅니다(npm 포함). 루트에서 실행합니다.

```bash
npm install
npm run dev        # 개발 서버 (apps/web), 계약 예시 더미 데이터를 만들고 20분마다 갱신
npm run live       # 개발 서버 + 운영 snapshot 읽기 전용 미러 (apps/web/.env.local에 운영 주소 필요)
npm run build      # 전체 빌드
npm run lint
npm run typecheck
npm run test       # 워크스페이스 전체 + 해변 생성기 테스트
```

개발 데이터 모드(`apps/web/public/data`, 저장소에 넣지 않음):

| 명령 | 데이터 |
|---|---|
| `npm run dev` | 계약 예시 더미(화면에 '개발용 예시' 안내) |
| `npm run live` | 운영 snapshot을 1분마다 확인해 새 버전만 받음. 공개 정적 파일만 읽고 인증·비밀값을 보내지 않음. 받아오기 실패는 게시하지 않음 |
| `npm run dev:no-data -w @baradun/web` | 데이터 없음 |

`npm run live`는 운영 CloudFront 주소(저장소 변수 `SITE_URL`)를 `apps/web/.env.local`(저장소에 넣지 않음)에서 읽습니다. 셸 환경변수로 넣으면 그 값이 우선합니다.

```bash
echo 'BARADUN_DEV_DATA_ORIGIN=https://<운영 CloudFront>' > apps/web/.env.local
```

모드를 바꾸면 이전 모드의 데이터는 지우고 시작합니다. 배포 빌드는 `public/data`가 있으면 멈춥니다(`--check`).

워크스페이스별 명령은 `-w`로 실행합니다. 예:

```bash
npm run storybook -w @baradun/web          # 컴포넌트 확인
npm run check:tokens -w @baradun/web       # 토큰 대비·금지 색 검사
npm run check:messages -w @baradun/web     # ko·en 문구 키 짝 검사
npm run check:beaches -w @baradun/contracts   # 해변 데이터 모양·slug 검사
npm run check:coverage -w @baradun/contracts  # 커버리지 매트릭스 검사
```

## 기준 문서

요구사항과 아키텍처 결정(ADR 포함)의 원본은 Notion 'V2 공식 문서 인덱스 · 현재 기준'입니다. 이 저장소의 문서와 다르면 Notion을 따릅니다. 작업 규칙은 [AGENTS.md](AGENTS.md)에 있습니다.
