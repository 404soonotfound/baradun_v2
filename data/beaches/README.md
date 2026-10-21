# data/beaches

해변 목록의 원본이에요(아키텍처 17.5, D2). 사이트의 `/spots/[slug]` 페이지와 publisher가 게시하는 `beaches.json`이 모두 여기서 만들어져요.

## 파일

- 해변 하나 = 파일 하나: `b0001.json` (파일 이름 = 내부 id)
- 내용은 계약의 Beach 모양을 따라요: `packages/contracts/schemas/contract.schema.json`의 `$defs/Beach`
- `.json`이 아닌 파일(이 README 등)은 검사와 빌드에서 읽지 않아요

## slug 규칙 (아키텍처 9장)

- 국어의 로마자 표기법, 소문자·숫자·하이픈만 (예: `gyeongpo`)
- '해수욕장·해변·해안'은 넣지 않아요 (`haesuyokjang`·`haebyeon`·`haean`)
- 이름이 겹칠 때만 시군 로마자를 앞에 붙여요 (예: `gangneung-songjeong`, `haeundae-songjeong`) — 결정 기록 11장 10/21 ②, 전국 해수부 수집본 기준으로 겹침 판단
- '리'는 로마자 그대로 써요 (예: `munam-2-ri`)
- 한 번 정한 slug는 바꾸거나, 해변을 지우거나, 다른 해변에 다시 쓰지 않아요
- 데이터 연결은 내부 id로 하고, slug는 주소에만 써요

## 해변을 숨기려면

파일을 지우지 말고 `"hidden": true`로 바꿔요. 목록·검색·즐겨찾기에서 숨고 상세 주소는 404가 돼요. 기기에 저장된 즐겨찾기 기록은 지우지 않아서, 다시 `false`로 바꾸면 돌아와요.

## 검사

```bash
npm run check:beaches -w packages/contracts
```

CI는 PR마다 main과 비교해서 slug 변경, 해변 삭제, slug 재사용을 막아요.

## 사람이 확인할 것 (자동 검사 못 함)

- 로마자 표기가 국어의 로마자 표기법에 맞는지
- 지역을 붙인 slug가 정말 이름이 겹치는 경우인지

## 함께 두는 파일 (BRD-59)

- `data/beach-coverage.csv`: BeachCoverageMatrix 공개본. 해변마다 단계(공개·보류·자동 제외), 좌표 출처, 특보구역(S1·L1)·관측소 배정 근거, 실응답 확인, 제외 사유만 둬요. 별표 원문·주소 연결 과정까지 담은 전체 매트릭스는 생성 때 저장소 밖 `$BARADUN_DATA_DIR/baradun-coverage/coverage-national.csv`로 나와요
- `data/beach-meta.json`: 계약 밖 부가 정보(검색 별칭, 2026 운영 기간). 해변 id로 연결
- 생성: `node tools/beaches/build.mjs --region 전국 --publish` (원자료·수집본·실응답 저장본은 저장소 밖 `$BARADUN_DATA_DIR`(기본 `~/data`)와 그 아래 `baradun-coverage/`, `tools/beaches/data-sources.json` 참고)
- 매트릭스의 `sea_rule_url`·`land_rule_url` 코드:
  - `훈령1185-별표5`: 예보업무규정(기상청훈령 제1185호) 별표5, <https://www.law.go.kr/LSW/flDownload.do?flSeq=166843467&bylClsCd=200201>
  - `훈령1185-별표9`: 같은 훈령 별표9, <https://www.law.go.kr/LSW/flDownload.do?flSeq=166843509&bylClsCd=200201>
- 검사: `npm run check:coverage -w packages/contracts` (근거 없는 매핑·필수 칸 누락·제외 사유 없는 행이면 실패)
