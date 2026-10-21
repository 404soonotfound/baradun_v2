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

생성기(`build.mjs --publish`)가 보류·자동 제외로 숨긴 해변은 `data/beach-meta.json`의 `_meta.auto_hidden`에 남고, 근거가 회복되면 다음 생성 때 자동으로 다시 공개돼요. 이런 해변을 근거와 상관없이 계속 숨기려면 `auto_hidden`에서 그 id를 지워요(그러면 사람이 숨긴 해변으로 봐요).

## 대표 사진 (`photo`, BRD-58)

- 공공누리 제1유형 사진만 넣어요. `license`는 코드값 `kogl-type1`로 쓰고, 화면 표기는 문구 키(`photo.license.*`)로 해요
- 생성기(`build.mjs --publish`)는 `photo`를 덮어쓰지 않고 지금 파일 값을 그대로 둬요. 새 해변은 `null`로 시작해요

## 활동 (`activities`, BRD-60)

- 수영(`swimming`)은 모든 해변에 넣어요. 스노클링은 출시 제외예요(결정 기록 11장 B7)
- 서핑(`surfing`)은 국립해양조사원 서핑지수 API(공공데이터포털 15142490, 공공누리 제1유형)의 포인트 **이름과 좌표만** 근거로 넣어요. 지수·점수 값은 쓰지 않아요(G1)
- 넣는 기준: 이름이 같은 해변이 포인트에서 2km 안에 있고, 사람이 확인한 경우
- 스쿠버 포인트는 섬·항구가 대부분이라 해수욕장에 붙이지 않아요(BRD-73에서 별도 장소로 다뤄요)
- 생성기(`build.mjs --publish`)는 `activities`를 덮어쓰지 않아요. 새 해변은 `["swimming"]`로 시작해요

2026-10-21 수집본(포인트 18곳) 기준으로 서핑을 넣은 해변 14곳:

| id    | 해변                       | API 포인트 이름    | 거리   |
| ----- | -------------------------- | ------------------ | ------ |
| b0002 | 경포해수욕장(강릉)         | 경포해수욕장       | 0.28km |
| b0008 | 옥계해수욕장(강릉)         | 옥계해수욕장       | 0.25km |
| b0012 | 금진해수욕장(강릉)         | 금진해수욕장       | 0.01km |
| b0025 | 송지호해수욕장(고성)       | 송지호해수욕장     | 0.14km |
| b0049 | 망상해수욕장(동해)         | 망상해수욕장       | 0.05km |
| b0073 | 남애3리해수욕장(양양)      | 남애3리해수욕장    | 0.18km |
| b0089 | 죽도해수욕장(양양)         | 죽도해수욕장       | 0.09km |
| b0096 | 송정해수욕장(해운대)       | 송정해수욕장       | 0.02km |
| b0121 | 진하해수욕장(울주)         | 진하해수욕장       | 0.02km |
| b0137 | 만리포해수욕장(태안)       | 만리포해수욕장     | 0.25km |
| b0208 | 신지명사십리해수욕장(완도) | 명사십리해수욕장   | 0.08km |
| b0267 | 송정솔바람해수욕장(남해)   | 송정솔바람해수욕장 | 0.22km |
| b0273 | 중문색달해수욕장(서귀포)   | 중문색달해수욕장   | 0.27km |
| b0276 | 곽지과물해수욕장(제주)     | 곽지해수욕장       | 0.12km |

넣지 않은 포인트 4곳: 남열해수욕장·월포해수욕장(해변이 지금 자동 제외 상태, BRD-74에서 다시 공개할 때 함께 넣음), 다대포해수욕장(해변 좌표 보류 중), 월정리해수욕장(해수부 해수욕장 목록에 없음).

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
