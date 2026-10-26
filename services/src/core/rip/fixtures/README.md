# 이안류 지수 실응답 픽스처 (BRD-57)

- `rip-songjung-20260815.json`: 2026-10-26 실호출(`beachCode=SONGJUNG&reqDate=20260815&type=json&numOfRows=300`) 응답에서 첫 줄(00:00)과 마지막 줄(23:55)만 남기고 줄임. `totalCount`는 남긴 줄 수에 맞춰 2로 바꿈(원문 287 — 파서가 받은 줄 수와 totalCount를 비교해 잘림을 판정하므로). 나머지 칸은 원문 그대로. 키는 들어 있지 않음.
- JSON 응답은 최상위가 `{ header, body }`(활용가이드 XML 예시의 `<response>` 감싸개 없음). `lastScr`는 숫자, `obsrvnDt`는 시간대 표기 없는 `yyyy-MM-dd HH:mm`(KST로 추정).
