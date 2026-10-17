# data/beaches

해변 목록의 원본이에요(아키텍처 17.5, D2). 사이트의 `/spots/[slug]` 페이지와 publisher가 게시하는 `beaches.json`이 모두 여기서 만들어져요.

## 파일

- 해변 하나 = 파일 하나: `b0001.json` (파일 이름 = 내부 id)
- 내용은 계약의 Beach 모양을 따라요: `packages/contracts/schemas/contract.schema.json`의 `$defs/Beach`
- `.json`이 아닌 파일(이 README 등)은 검사와 빌드에서 읽지 않아요

## slug 규칙 (아키텍처 9장)

- 국어의 로마자 표기법, 소문자·숫자·하이픈만 (예: `gyeongpo`)
- '해수욕장·해변·해안'은 넣지 않아요 (`haesuyokjang`·`haebyeon`·`haean`)
- 이름이 겹칠 때만 지역을 붙여요 (예: `jinha-ulju`)
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
